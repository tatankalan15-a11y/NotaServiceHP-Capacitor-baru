/**
 * Kripto lisensi: SHA-256 + HMAC-SHA256 (murni JS, sinkron).
 * Digunakan untuk SN toko & kode aktivasi.
 * HARUS sama algoritma-nya dengan KeygenNotaHP.
 */

// ---- SHA-256 (FIPS 180-4), implementasi ringkas sinkron ----
function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

function sha256(ascii) {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  const utf8 = unescape(encodeURIComponent(ascii));
  const words = [];
  for (let i = 0; i < utf8.length; i++) words[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
  const bitLen = utf8.length * 8;
  words[bitLen >> 5] |= 0x80 << (24 - bitLen % 32);
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;

  let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
  let H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;

  const w = new Array(64);
  for (let i = 0; i < words.length; i += 16) {
    let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
    for (let j = 0; j < 64; j++) {
      if (j < 16) w[j] = words[i + j] | 0;
      else {
        const g0 = w[j - 15], g1 = w[j - 2];
        const s0 = rotr(7, g0) ^ rotr(18, g0) ^ (g0 >>> 3);
        const s1 = rotr(17, g1) ^ rotr(19, g1) ^ (g1 >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
  }
  function hex(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
  return (hex(H0) + hex(H1) + hex(H2) + hex(H3) + hex(H4) + hex(H5) + hex(H6) + hex(H7)).toUpperCase();
}

/** HMAC-SHA256(key, message) → hex uppercase 64 chars */
export function hmacSha256(key, message) {
  const block = 64;
  let k = unescape(encodeURIComponent(key));
  if (k.length > block) {
    const hk = sha256(key);
    k = '';
    for (let i = 0; i < hk.length; i += 2) k += String.fromCharCode(parseInt(hk.substr(i, 2), 16));
  }
  while (k.length < block) k += '\0';
  let oKey = '', iKey = '';
  for (let i = 0; i < block; i++) {
    const c = k.charCodeAt(i);
    oKey += String.fromCharCode(c ^ 0x5c);
    iKey += String.fromCharCode(c ^ 0x36);
  }
  // Inner/outer via binary-safe path: hash of string built from bytes
  function strHash(s) {
    // s may contain binary; convert to latin1-ish for sha256 input
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) & 0xff);
    return sha256Bytes(out);
  }
  return strHash(oKey + hexToRaw(strHash(iKey + unescape(encodeURIComponent(message)))));
}

function hexToRaw(hex) {
  let s = '';
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
}

function sha256Bytes(latin1) {
  // same as sha256 but input is raw 0-255 string (no UTF-8 re-encode)
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  const words = [];
  for (let i = 0; i < latin1.length; i++) words[i >> 2] |= (latin1.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
  const bitLen = latin1.length * 8;
  words[bitLen >> 5] |= 0x80 << (24 - bitLen % 32);
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;
  let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
  let H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;
  const w = new Array(64);
  for (let i = 0; i < words.length; i += 16) {
    let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
    for (let j = 0; j < 64; j++) {
      if (j < 16) w[j] = words[i + j] | 0;
      else {
        const g0 = w[j - 15], g1 = w[j - 2];
        const s0 = rotr(7, g0) ^ rotr(18, g0) ^ (g0 >>> 3);
        const s1 = rotr(17, g1) ^ rotr(19, g1) ^ (g1 >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
  }
  function hex(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
  return (hex(H0) + hex(H1) + hex(H2) + hex(H3) + hex(H4) + hex(H5) + hex(H6) + hex(H7)).toUpperCase();
}

export function sha256Hex(str) {
  return sha256(str);
}

/** SECRET digabung runtime (bukan satu literal utuh di source). Sama di keygen. */
const _k = ['Nshp!', '2026#', 'Hk9mQ2v', 'R7xLp4w', 'YzAeBtCuDf'];
export const LICENSE_SECRET = _k.join('');
export const LICENSE_PREFIX = 'NSHP';
export const LICENSE_TRIAL_LIMIT = 100;

/** Tanda tangan blob lisensi — cegah edit manual localStorage. */
export function signLicenseBlob(blob) {
  const body = [
    blob.sn || '',
    blob.activated ? '1' : '0',
    String(blob.trialUsed | 0),
    blob.activatedAt || ''
  ].join('|');
  return hmacSha256(LICENSE_SECRET, 'LIC|' + body);
}

export function verifyLicenseBlob(blob) {
  if (!blob || typeof blob !== 'object' || !blob.sig) return false;
  return blob.sig === signLicenseBlob(blob);
}

/** SN dari data toko (HMAC), format NSHP-XXXXXXXX */
export function generateSNFromToko(nama, alamat, telepon) {
  const base = [nama || '', alamat || '', telepon || '']
    .map(s => String(s).trim().toUpperCase().replace(/\s+/g, ' '))
    .join('|');
  const seed = base.replace(/\|/g, '') ? base : 'DEFAULT-TOKO-KOSONG';
  const h = hmacSha256(LICENSE_SECRET, 'SN|' + seed);
  return LICENSE_PREFIX + '-' + h.substring(0, 8);
}

/** Kode aktivasi dari SN: HMAC → 4 grup 6 hex */
export function generateActivationCode(sn) {
  const clean = (sn || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (!clean) return '';
  const h = hmacSha256(LICENSE_SECRET, 'ACT|' + clean);
  return [h.substring(0, 6), h.substring(6, 12), h.substring(12, 18), h.substring(18, 24)].join('-');
}

export function isValidActivation(sn, code) {
  if (!sn || !code) return false;
  const expected = generateActivationCode(sn);
  return code.replace(/\s/g, '').toUpperCase() === expected.replace(/\s/g, '').toUpperCase();
}
