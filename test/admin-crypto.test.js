import test from "node:test";
import assert from "node:assert/strict";
import { createVault, encryptToken, decryptToken, STORAGE_KEY, PBKDF2_ITERATIONS } from "../src/admin/crypto.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

test("encrypt/decrypt round trip with 310k iterations, 16-byte salt, 12-byte IV", async () => {
  const rec = await encryptToken("github_pat_secret", "correcta-123");
  assert.equal(rec.iter, PBKDF2_ITERATIONS);
  assert.equal(PBKDF2_ITERATIONS, 310000);
  assert.equal(Buffer.from(rec.salt, "base64").length, 16);
  assert.equal(Buffer.from(rec.iv, "base64").length, 12);
  assert.ok(!JSON.stringify(rec).includes("github_pat_secret"));
  assert.equal(await decryptToken(rec, "correcta-123"), "github_pat_secret");
});

test("wrong password fails with 'Contraseña incorrecta'", async () => {
  const rec = await encryptToken("tok", "correcta-123", { iterations: 1000 });
  await assert.rejects(decryptToken(rec, "otra-cosa-1"), { message: "Contraseña incorrecta", code: "wrong-password" });
});

test("vault stores only ciphertext under album-admin-v1 and unlocks later", async () => {
  const storage = memStorage();
  const v = createVault({ storage, iterations: 1000 });
  await v.setup("github_pat_abc", "password-ok");
  const raw = storage.getItem(STORAGE_KEY);
  assert.ok(raw && !raw.includes("github_pat_abc"));
  const v2 = createVault({ storage, iterations: 1000 });
  assert.equal(v2.hasStoredToken(), true);
  assert.equal(v2.getToken(), null);
  assert.equal(await v2.unlock("password-ok"), "github_pat_abc");
  assert.equal(v2.isUnlocked(), true);
});

test("setup rejects passwords shorter than 8", async () => {
  const v = createVault({ storage: memStorage(), iterations: 1000 });
  await assert.rejects(v.setup("tok", "short"), { code: "short-password" });
});

test("5 failures lock for 30 s, then unlock works again", async () => {
  const storage = memStorage();
  let t = 1000;
  const v = createVault({ storage, iterations: 1000, now: () => t });
  await v.setup("tok", "password-ok");
  v.lock();
  for (let i = 0; i < 4; i++) {
    await assert.rejects(v.unlock("mala-clave-1"), { code: "wrong-password" });
  }
  await assert.rejects(v.unlock("mala-clave-1"), { code: "locked" });
  assert.equal(v.isLocked(), true);
  // Even the right password is refused while locked.
  await assert.rejects(v.unlock("password-ok"), { code: "locked" });
  t += 29999;
  assert.equal(v.isLocked(), true);
  t += 1;
  assert.equal(v.isLocked(), false);
  assert.equal(await v.unlock("password-ok"), "tok");
});

test("forget deletes ciphertext and memory token", async () => {
  const storage = memStorage();
  const v = createVault({ storage, iterations: 1000 });
  await v.setup("tok", "password-ok");
  v.forget();
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(v.getToken(), null);
  assert.equal(v.hasStoredToken(), false);
});
