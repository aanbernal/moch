// Admin token vault: PBKDF2-SHA-256 -> AES-GCM. Only ciphertext is persisted
// (localStorage key "album-admin-v1"); the plain token lives in memory only.
// Uses WebCrypto (globalThis.crypto.subtle) so it also runs under Node.

export const STORAGE_KEY = "album-admin-v1";
export const PBKDF2_ITERATIONS = 310000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const MAX_FAILURES = 5;
export const LOCK_MS = 30000;
export const MIN_PASSWORD = 8;

export const MSG_WRONG_PASSWORD = "Contraseña incorrecta";
export const MSG_SHORT_PASSWORD = "La contraseña debe tener al menos 8 caracteres.";

export class VaultError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(subtle, password, salt, iterations) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt text with a password. Returns a JSON-serialisable record. */
export async function encryptToken(token, password, { crypto = globalThis.crypto, iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(crypto.subtle, password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { v: 1, kdf: "PBKDF2-SHA-256", iter: iterations, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Decrypt a record. Throws VaultError("wrong-password") when the GCM tag fails. */
export async function decryptToken(record, password, { crypto = globalThis.crypto } = {}) {
  try {
    const key = await deriveKey(crypto.subtle, password, fromB64(record.salt), record.iter);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(record.iv) }, key, fromB64(record.ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new VaultError("wrong-password", MSG_WRONG_PASSWORD);
  }
}

/**
 * Vault with lockout. `storage` (getItem/setItem/removeItem) and `now` are injectable.
 */
export function createVault({
  storage = globalThis.localStorage,
  crypto = globalThis.crypto,
  now = () => Date.now(),
  iterations = PBKDF2_ITERATIONS,
} = {}) {
  let token = null;
  let failures = 0;
  let lockedUntil = 0;

  function readRecord() {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      return rec && rec.ct && rec.salt && rec.iv && rec.iter ? rec : null;
    } catch {
      return null;
    }
  }

  function lockRemainingMs() {
    return Math.max(0, lockedUntil - now());
  }

  return {
    hasStoredToken: () => readRecord() !== null,
    isUnlocked: () => token !== null,
    getToken: () => token,
    lockRemainingMs,
    isLocked: () => lockRemainingMs() > 0,

    /** First visit: store the encrypted token and keep the plain one in memory. */
    async setup(plainToken, password) {
      if (typeof plainToken !== "string" || plainToken.trim() === "") {
        throw new VaultError("empty-token", "Pega el token de GitHub.");
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD) {
        throw new VaultError("short-password", MSG_SHORT_PASSWORD);
      }
      const clean = plainToken.trim();
      const rec = await encryptToken(clean, password, { crypto, iterations });
      storage.setItem(STORAGE_KEY, JSON.stringify(rec));
      token = clean;
      failures = 0;
      lockedUntil = 0;
      return true;
    },

    /** Later visits: password only. 5 failures lock the form for 30 s. */
    async unlock(password) {
      const remaining = lockRemainingMs();
      if (remaining > 0) {
        throw new VaultError("locked", `Demasiados intentos. Espera ${Math.ceil(remaining / 1000)} s.`, { remainingMs: remaining });
      }
      const rec = readRecord();
      if (!rec) throw new VaultError("no-token", "No hay token guardado en este dispositivo.");
      try {
        token = await decryptToken(rec, password, { crypto });
        failures = 0;
        return token;
      } catch (err) {
        failures += 1;
        if (failures >= MAX_FAILURES) {
          failures = 0;
          lockedUntil = now() + LOCK_MS;
          throw new VaultError("locked", `Demasiados intentos. Espera ${LOCK_MS / 1000} s.`, { remainingMs: LOCK_MS });
        }
        throw err;
      }
    },

    /** Drop the in-memory token (ciphertext stays). */
    lock() {
      token = null;
    },

    /** "Olvidar este dispositivo": delete ciphertext and memory. */
    forget() {
      storage.removeItem(STORAGE_KEY);
      token = null;
      failures = 0;
      lockedUntil = 0;
    },
  };
}
