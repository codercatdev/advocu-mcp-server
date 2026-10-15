import type { ProviderCredentials } from "../unifiedServer.js";
import type { HostedEnv } from "./auth.js";

async function encryptionKey(encoded: string) {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("Invalid credential encryption key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function validateCredentials(input: unknown): ProviderCredentials {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid credentials");
  const value = input as Record<string, unknown>;
  const result: ProviderCredentials = {};
  const token = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 16384 || /[\r\n]/.test(value)) {
      throw new Error("Invalid provider token");
    }
    return value.trim();
  };
  if (value.gde !== undefined) {
    const gde = value.gde as Record<string, unknown> | null;
    result.gde = { accessToken: token(gde?.accessToken) };
  }
  if (value.mvp !== undefined) {
    const mvp = value.mvp as Record<string, unknown> | null;
    const id = mvp?.userProfileId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Invalid MVP profile ID");
    }
    result.mvp = { accessToken: token(mvp?.accessToken), userProfileId: id };
  }
  return result;
}

export async function saveCredentials(env: HostedEnv, userId: string, credentials: ProviderCredentials) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    await encryptionKey(env.CREDENTIAL_ENCRYPTION_KEY),
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  const encoded = btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext)));
  await env.DB.prepare(
    `INSERT INTO provider_credentials (user_id, ciphertext) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext`,
  )
    .bind(userId, encoded)
    .run();
}

export async function loadCredentials(env: HostedEnv, userId: string): Promise<ProviderCredentials> {
  const row = await env.DB.prepare("SELECT ciphertext FROM provider_credentials WHERE user_id = ?")
    .bind(userId)
    .first<{ ciphertext: string }>();
  if (!row) return {};
  const bytes = Uint8Array.from(atob(row.ciphertext), (char) => char.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(userId) },
    await encryptionKey(env.CREDENTIAL_ENCRYPTION_KEY),
    bytes.slice(12),
  );
  return validateCredentials(JSON.parse(new TextDecoder().decode(plaintext)));
}
