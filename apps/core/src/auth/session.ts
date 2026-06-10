/**
 * Server-side identity (T2.1). Validates the Keycloak OIDC bearer token against
 * the realm JWKS and builds a Principal from claims via the existing
 * `principalFromClaims`. The browser NEVER supplies a Principal directly.
 *
 * Dev bypass (config.devAuth): trust an `x-dev-principal` header carrying JSON
 * OIDC claims, defaulting to the demo admin — so local/CI runs need no Keycloak.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { principalFromClaims, type OidcClaims, type Principal } from "@companyos/auth";
import type { CoreConfig } from "../config.js";

export interface Authenticator {
  /** Resolve a Principal from request headers, or throw if unauthenticated. */
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal>;
}

function bearer(headers: Record<string, string | string[] | undefined>): string | undefined {
  const h = headers["authorization"];
  const v = Array.isArray(h) ? h[0] : h;
  if (v && v.toLowerCase().startsWith("bearer ")) return v.slice(7).trim();
  return undefined;
}

export function createAuthenticator(config: CoreConfig): Authenticator {
  if (config.devAuth || !config.oidc) {
    const org = config.defaultOrg;
    return {
      async authenticate(headers) {
        const raw = headers["x-dev-principal"];
        const v = Array.isArray(raw) ? raw[0] : raw;
        const claims: OidcClaims = v
          ? (JSON.parse(v) as OidcClaims)
          : { sub: "alice", org_id: org, realm_access: { roles: ["admin"] }, groups: ["leadership"] };
        return principalFromClaims(claims, org);
      }
    };
  }

  const { issuer, clientId } = config.oidc;
  const jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`));
  return {
    async authenticate(headers) {
      const token = bearer(headers);
      if (!token) throw new UnauthorizedError("missing bearer token");
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer });
        // Keycloak puts client roles under resource_access[clientId]; we accept
        // realm roles (realm_access) and the standard claims.
        return principalFromClaims(payload as OidcClaims, config.defaultOrg);
      } catch (err) {
        throw new UnauthorizedError(`token validation failed: ${(err as Error).message}`);
      }
      // clientId reserved for audience checks once clients set `aud`.
      void clientId;
    }
  };
}

export class UnauthorizedError extends Error {
  readonly status = 401;
}
