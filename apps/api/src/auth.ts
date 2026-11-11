import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { audit, type Db } from "./db.js";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function presentedKey(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  const x = req.headers["x-api-key"];
  return typeof x === "string" ? x.trim() : undefined;
}

/**
 * Protected-operation guard. Keys are stored only as SHA-256 digests (API_KEYS_SHA256);
 * comparison is constant-time against every configured digest. If no keys are configured,
 * protected endpoints are DISABLED (fail closed), never open.
 */
export function requireApiKey(digests: string[], db: Db, action: string) {
  const expected = digests.map((d) => Buffer.from(d, "hex"));
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (expected.length === 0) {
      audit(db, { requestId: req.id, ip: req.ip, action, outcome: "disabled" });
      return reply.code(503).send({ error: { code: "PROTECTED_ENDPOINTS_DISABLED", message: "No API keys configured (API_KEYS_SHA256).", requestId: req.id } });
    }
    const key = presentedKey(req);
    const got = key ? Buffer.from(sha256Hex(key), "hex") : Buffer.alloc(32);
    let ok = false;
    for (const e of expected) ok = timingSafeEqual(got, e) || ok; // no early exit
    if (!key || !ok) {
      audit(db, { requestId: req.id, ip: req.ip, action, outcome: "unauthorized" });
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key required (Authorization: Bearer <key>).", requestId: req.id } });
    }
  };
}
