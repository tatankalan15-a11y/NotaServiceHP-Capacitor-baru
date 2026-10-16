/**
 * Enkripsi data offline — Web Crypto API
 * - Kunci: PBKDF2 (SHA-256, 120000 iterasi) dari PIN toko
 * - Cipher: AES-256-GCM
 * - Verifier: untuk cek PIN tanpa menyimpan PIN
 */

const PBKDF2_ITERATIONS = 120000;
const SALT_LEN = 16;
const IV_LEN = 12;

function bufToB64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function deriveKey(pin, saltBuf) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(pin)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Enkripsi string → { iv, data } (base64) */
export async function encryptText(plainText, key) {
  const iv = randomBytes(IV_LEN);
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plainText)
  );
  return { iv: bufToB64(iv), data: bufToB64(cipher) };
}

/** Dekripsi { iv, data } → string */
export async function decryptText(payload, key) {
  const iv = b64ToBuf(payload.iv);
  const data = b64ToBuf(payload.data);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    data
  );
  return new TextDecoder().decode(plain);
}

/** Enkripsi objek → record terenkripsi untuk IndexedDB */
export async function encryptObject(obj, key) {
  const json = JSON.stringify(obj);
  const { iv, data } = await encryptText(json, key);
  return {
    id: obj.id,
    _enc: true,
    _v: 1,
    iv,
    data
  };
}

/** Dekripsi record IDB → objek asli (atau kembalikan apa adanya jika belum terenkripsi) */
export async function decryptObject(record, key) {
  if (!record || !record._enc) return record;
  const json = await decryptText({ iv: record.iv, data: record.data }, key);
  return JSON.parse(json);
}

/**
 * Setup enkripsi baru: buat salt + verifier dari PIN.
 * Verifier = enkripsi string tetap, dipakai untuk validasi PIN.
 */
export async function setupEncryption(pin) {
  const salt = randomBytes(SALT_LEN);
  const key = await deriveKey(pin, salt.buffer);
  const verifier = await encryptText('NOTA-HP-OK-v1', key);
  return {
    enabled: true,
    salt: bufToB64(salt),
    verifier,
    createdAt: new Date().toISOString()
  };
}

/** Buka kunci dari PIN + meta (salt/verifier). Return CryptoKey atau throw. */
export async function unlockWithPin(pin, meta) {
  if (!meta || !meta.salt || !meta.verifier) throw new Error('Enkripsi belum disetel');
  const saltBuf = b64ToBuf(meta.salt);
  const key = await deriveKey(pin, saltBuf);
  try {
    const check = await decryptText(meta.verifier, key);
    if (check !== 'NOTA-HP-OK-v1') throw new Error('PIN salah');
  } catch (e) {
    if (e && e.message === 'PIN salah') throw e;
    throw new Error('PIN salah');
  }
  return key;
}

/** Enkripsi seluruh backup JSON (string) → objek file backup terenkripsi */
export async function encryptBackupPayload(jsonString, key) {
  const { iv, data } = await encryptText(jsonString, key);
  return {
    format: 'nshp-encrypted-backup',
    version: 1,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    exported: new Date().toISOString(),
    iv,
    data
  };
}

/** Dekripsi file backup terenkripsi → string JSON */
export async function decryptBackupPayload(fileObj, key) {
  if (!fileObj || fileObj.format !== 'nshp-encrypted-backup') {
    throw new Error('Bukan backup terenkripsi Nota Service HP');
  }
  return decryptText({ iv: fileObj.iv, data: fileObj.data }, key);
}

export function isEncryptedRecord(r) {
  return !!(r && r._enc && r.data && r.iv);
}

export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.encrypt === 'function';
}
