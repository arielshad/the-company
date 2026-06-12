/**
 * Node.js-only HMAC utilities and conformance test runner.
 * Do NOT import this from browser-bundled code — use sdk.ts for types/interfaces.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  SourceConnector,
  SourceAcl,
  NativePermissions,
  WebhookContext,
  SyncContext,
  ConformanceFixtures,
  ConformanceResult,
} from "./sdk.js";

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a.padEnd(64, "\0"));
  const bBuf = Buffer.from(b.padEnd(64, "\0"));
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

export async function runConformance(
  connector: SourceConnector,
  fixtures: ConformanceFixtures
): Promise<ConformanceResult> {
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(`[${connector.name}] ${msg}`);

  if (!connector.name || connector.name.trim() === "") {
    fail("name must be a non-empty string");
  }

  if (connector.mapAcl) {
    if (!fixtures.aclCases || fixtures.aclCases.length === 0) {
      fail("mapAcl present but no aclCases provided in fixtures");
    } else {
      for (const { native, expected, label } of fixtures.aclCases) {
        const lbl = label ?? JSON.stringify(native).slice(0, 60);
        const r1 = connector.mapAcl(native);
        const r2 = connector.mapAcl(native);
        if (JSON.stringify(r1) !== JSON.stringify(r2)) {
          fail(`mapAcl not deterministic for: ${lbl}`);
        }
        if (r1.public === true && expected.public !== true) {
          fail(`mapAcl returned public=true but expected.public is not true for: ${lbl}`);
        }
        const gotAllow = [...r1.allow].sort();
        const wantAllow = [...expected.allow].sort();
        if (JSON.stringify(gotAllow) !== JSON.stringify(wantAllow)) {
          fail(`mapAcl allow[] mismatch for ${lbl}: got [${gotAllow}] want [${wantAllow}]`);
        }
        if (!!r1.public !== !!expected.public) {
          fail(`mapAcl public mismatch for ${lbl}: got ${r1.public} want ${expected.public}`);
        }
      }
    }
  }

  if (connector.verifyWebhook) {
    if (fixtures.validWebhook) {
      const { headers, rawBody, ctx } = fixtures.validWebhook;
      if (!connector.verifyWebhook(headers, rawBody, ctx)) fail("verifyWebhook rejected a valid webhook");
    }
    if (fixtures.tamperedWebhook) {
      const { headers, rawBody, ctx } = fixtures.tamperedWebhook;
      if (connector.verifyWebhook(headers, rawBody, ctx)) fail("verifyWebhook accepted a tampered webhook");
    }
  }

  if (connector.backfill && fixtures.backfillCtx && fixtures.backfillExpected) {
    try {
      const gen = connector.backfill(fixtures.backfillCtx);
      const first = await gen.next();
      if (first.done || !first.value) {
        fail("backfill yielded no items");
      } else {
        const { source } = first.value;
        if (source.connector !== fixtures.backfillExpected.connector) {
          fail(`backfill source.connector: got "${source.connector}" want "${fixtures.backfillExpected.connector}"`);
        }
        if (source.externalId !== fixtures.backfillExpected.externalId) {
          fail(`backfill externalId: got "${source.externalId}" want "${fixtures.backfillExpected.externalId}"`);
        }
        const gen2 = connector.backfill(fixtures.backfillCtx);
        const first2 = await gen2.next();
        if (!first2.done && first2.value) {
          if (first2.value.source.externalId !== source.externalId) {
            fail("backfill externalId not stable across calls (not idempotent)");
          }
        }
      }
    } catch (e) {
      fail(`backfill threw unexpectedly: ${(e as Error).message}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
