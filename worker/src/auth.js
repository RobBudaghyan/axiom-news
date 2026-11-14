// Telegram Mini App initData check (core.telegram.org/bots/webapps, "Validating data received via
// the Mini App"): secret_key = HMAC_SHA256(key "WebAppData", bot_token); the hash must equal
// hex(HMAC_SHA256(key secret_key, data_check_string)), where data_check_string is every received
// field except `hash`, sorted by key, as "key=value" lines joined by "\n". The user id the API
// uses comes ONLY from data that passed this check.

export const MAX_AGE_S = 24 * 3600;   // initData older than this is refused
const enc = new TextEncoder();
const keyCache = new Map();           // bot token -> CryptoKey (one per isolate, saves CPU)

async function hmacKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function secretKey(botToken) {
  if (!keyCache.has(botToken)) {
    const web = await hmacKey(enc.encode("WebAppData"));
    const secret = await crypto.subtle.sign("HMAC", web, enc.encode(botToken));
    keyCache.set(botToken, await hmacKey(secret));
  }
  return keyCache.get(botToken);
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function sameHex(a, b) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function dataCheckString(params) {
  return [...params.entries()].filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("\n");
}

export async function signInitData(fields, botToken) {   // used by tests and the local preview
  const params = new URLSearchParams(fields);
  const key = await secretKey(botToken);
  params.set("hash", toHex(await crypto.subtle.sign("HMAC", key, enc.encode(dataCheckString(params)))));
  return params.toString();
}

// Returns {ok: true, user, authDate} or {ok: false, reason}.
export async function verifyInitData(initData, botToken, now, maxAge = MAX_AGE_S) {
  if (!initData || typeof initData !== "string" || initData.length > 4096) return { ok: false, reason: "missing" };
  if (!botToken) return { ok: false, reason: "server not configured" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash" };
  const key = await secretKey(botToken);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, enc.encode(dataCheckString(params))));
  if (!sameHex(hash.toLowerCase(), expected)) return { ok: false, reason: "bad hash" };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: "no auth_date" };
  if (now - authDate > maxAge) return { ok: false, reason: "expired" };
  if (authDate - now > 300) return { ok: false, reason: "auth_date in the future" };
  let user;
  try { user = JSON.parse(params.get("user") ?? "null"); } catch { user = null; }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return { ok: false, reason: "no user" };
  return { ok: true, user, authDate };
}
