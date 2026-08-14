import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "v1";

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded " +
        "(openssl rand -base64 32)"
    );
  }
  return buf;
}

/**
 * The stored installation carries the workspace's bot token, which can post as
 * Hawk Bot anywhere the app is invited. Encrypted at rest so a stolen copy of
 * the SQLite file is not itself a breach.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== PREFIX || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM authentication failed. In practice this is always the same cause,
    // and the raw message ("Unsupported state or unable to authenticate
    // data") says nothing useful to whoever has to fix it.
    throw new Error(
      "Stored installation could not be decrypted — TOKEN_ENCRYPTION_KEY does " +
        "not match the one that wrote it. Restore the original key, or have an " +
        "admin reinstall the app from PUBLIC_URL/slack/install."
    );
  }
}
