/**
 * OpenFGA authorization backend for CompanyOS.
 *
 * Provides:
 *  - FgaTransport: small seam for unit-testing without a running server
 *  - OpenFgaAuthz: AuthzEngine implementation that delegates to a FgaTransport
 *  - createOpenFgaTransport: real transport backed by @openfga/sdk
 *  - setupOpenFgaStore: helper to create a store and write the model (tests/bootstrap)
 */

import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import type { AuthzEngine, Tuple } from "./index.js";

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * Minimal transport interface so OpenFgaAuthz is testable without a real server.
 * The write method always receives both arrays; callers must omit empty ones if
 * the underlying API requires it (createOpenFgaTransport handles that).
 */
export interface FgaTransport {
  write(writes: Tuple[], deletes: Tuple[]): Promise<void>;
  check(subject: string, relation: string, object: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// AuthzEngine backed by any FgaTransport
// ---------------------------------------------------------------------------

export class OpenFgaAuthz implements AuthzEngine {
  constructor(private readonly transport: FgaTransport) {}

  async write(t: Tuple): Promise<void> {
    await this.transport.write([t], []);
  }

  async delete(t: Tuple): Promise<void> {
    await this.transport.write([], [t]);
  }

  async check(subject: string, relation: string, object: string): Promise<boolean> {
    return this.transport.check(subject, relation, object);
  }
}

// ---------------------------------------------------------------------------
// Real transport backed by @openfga/sdk
// ---------------------------------------------------------------------------

function tupleToFgaKey(t: Tuple) {
  return { user: t.subject, relation: t.relation, object: t.object };
}

/**
 * Create a real FgaTransport that talks to an OpenFGA server.
 *
 * @param opts.apiUrl              Base URL of the OpenFGA server, e.g. "http://localhost:8080"
 * @param opts.storeId             Store ID (must already exist)
 * @param opts.authorizationModelId  Optional; pin to a specific model version
 */
export function createOpenFgaTransport(opts: {
  apiUrl: string;
  storeId: string;
  authorizationModelId?: string;
}): FgaTransport {
  const client = new OpenFgaClient({
    apiUrl: opts.apiUrl,
    storeId: opts.storeId,
    authorizationModelId: opts.authorizationModelId,
  });

  return {
    async write(writes: Tuple[], deletes: Tuple[]): Promise<void> {
      const body: { writes?: ReturnType<typeof tupleToFgaKey>[]; deletes?: ReturnType<typeof tupleToFgaKey>[] } = {};
      if (writes.length > 0) body.writes = writes.map(tupleToFgaKey);
      if (deletes.length > 0) body.deletes = deletes.map(tupleToFgaKey);
      // If both arrays are empty there is nothing to do.
      if (!body.writes && !body.deletes) return;
      await client.write(body);
    },

    async check(subject: string, relation: string, object: string): Promise<boolean> {
      const resp = await client.check({ user: subject, relation, object });
      return !!resp.allowed;
    },
  };
}

// ---------------------------------------------------------------------------
// Setup helper: create store + write model (used by integration tests / bootstrap)
// ---------------------------------------------------------------------------

/**
 * Create a new OpenFGA store, write the given DSL model into it, and return
 * the resulting storeId and authorizationModelId.
 *
 * @param apiUrl    Base URL of the OpenFGA server
 * @param modelDsl  Contents of a .fga DSL file
 * @param storeName Name for the new store (default: "companyos-test")
 */
export async function setupOpenFgaStore(
  apiUrl: string,
  modelDsl: string,
  storeName = "companyos-test",
): Promise<{ storeId: string; authorizationModelId: string }> {
  // 1. Create the store (no storeId required yet)
  const bootstrapClient = new OpenFgaClient({ apiUrl });
  const storeResp = await bootstrapClient.createStore({ name: storeName });
  const storeId = storeResp.id;

  // 2. Convert the DSL to the JSON model object expected by the API
  //    transformer.transformDSLToJSONObject returns Omit<AuthorizationModel, "id">
  const authorizationModel = transformer.transformDSLToJSONObject(modelDsl);

  // 3. Write the model using a client configured with the new storeId
  const storeClient = new OpenFgaClient({ apiUrl, storeId });
  const modelResp = await storeClient.writeAuthorizationModel(authorizationModel);
  const authorizationModelId = modelResp.authorization_model_id;

  return { storeId, authorizationModelId };
}
