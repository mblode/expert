import { createHash, randomBytes } from "node:crypto";

/** Opaque URL token. Only the hash is stored. */
export function newOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
