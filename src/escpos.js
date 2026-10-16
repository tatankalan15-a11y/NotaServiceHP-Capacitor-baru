// Encoder ESC/POS murni (tanpa dependensi) — bisa diuji di Node maupun dipakai di aplikasi.
//
// Format masukan (sama dengan NotaPrinter.buildText di app.js):
//   [L]teks         rata kiri
//   [C]teks         rata tengah
//   [R]teks         rata kanan
//   [L]kiri [R]kanan   dua kolom dalam satu baris
//   <b>..</b>       tebal
//   <font size='big'>..</font>   huruf besar (2x lebar & tinggi)
// Hanya karakter ASCII yang dicetak (karakter lain diganti '?'), agar aman di semua printer.

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

const INIT = [ESC, 0x40];
const BOLD_ON = [ESC, 0x45, 1];
const BOLD_OFF = [ESC, 0x45, 0];
const SIZE_NORMAL = [GS, 0x21, 0x00];
const SIZE_BIG = [GS, 0x21, 0x11];
const ALIGN = { L: [ESC, 0x61, 0], C: [ESC, 0x61, 1], R: [ESC, 0x61, 2] };

function toAscii(s) {
  const bytes = [];
  for (const ch of String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')) {
    const c = ch.codePointAt(0);
    bytes.push(c >= 32 && c < 127 ? c : 63);
  }
  return bytes;
}

// Pecah teks per kata agar tidak melebihi lebar kolom (kata yang lebih panjang dari lebar dipotong).
function wrap(text, width) {
  const out = [];
  let cur = '';
  for (let w of text.split(' ')) {
    while (w.length > width) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    const next = cur ? cur + ' ' + w : w;
    if (next.length > width) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

const stripTags = s => s.replace(/<[^>]*>/g, '');

// Render satu potongan teks yang boleh berisi <b>..</b>; kembalikan byte-nya saja.
function inline(s, boldState) {
  const out = [];
  for (const part of s.split(/(<\/?b>)/i)) {
    if (/^<b>$/i.test(part)) { out.push(...BOLD_ON); boldState.on = true; }
    else if (/^<\/b>$/i.test(part)) { out.push(...BOLD_OFF); boldState.on = false; }
    else if (part) out.push(...toAscii(stripTags(part)));
  }
  return out;
}

/**
 * @param {string} text   teks bertag
 * @param {object} opts   { width: karakter per baris (32 = 58mm, 48 = 80mm), feed: baris kosong sebelum potong, cut: boolean }
 * @returns {Uint8Array}
 */
export function tagsToEscPos(text, opts = {}) {
  const width = opts.width || 32;
  const feed = opts.feed ?? 4;
  const out = [...INIT];

  for (const raw of String(text ?? '').split('\n')) {
    let line = raw;
    let big = false;
    if (/<font\s+size=['"]big['"]\s*>/i.test(line)) {
      big = true;
      line = line.replace(/<font\s+size=['"]big['"]\s*>/ig, '').replace(/<\/font>/ig, '');
    }
    const w = big ? Math.floor(width / 2) : width;

    const m = line.match(/^\[([LCR])\](.*)$/s);
    const align = m ? m[1] : 'L';
    const body = m ? m[2] : line;
    const bold = { on: false };

    if (big) out.push(...SIZE_BIG);
    out.push(...ALIGN[align]);

    const cols = align === 'L' ? body.match(/^(.*?)\s*\[R\](.*)$/s) : null;
    if (cols) {
      // Dua kolom: kiri + spasi + kanan, selalu pas selebar kertas.
      const left = cols[1], right = cols[2];
      const lp = stripTags(left), rp = stripTags(right).trim();
      if (lp.length + 1 + rp.length <= w) {
        out.push(...inline(left, bold), ...toAscii(' '.repeat(w - lp.length - rp.length)));
        out.push(...inline(right.trim(), bold));
      } else {
        // Tidak muat: kiri dibungkus, kanan di baris sendiri rata kanan.
        const parts = wrap(lp, w);
        parts.forEach((p, i) => { out.push(...toAscii(p)); if (i < parts.length - 1) out.push(LF); });
        out.push(LF, ...ALIGN.R, ...inline(right.trim(), bold));
      }
    } else if (align === 'L' || align === 'R') {
      // Bungkus per kata; tag <b> hanya dipertahankan bila baris tidak perlu dibungkus.
      const plain = stripTags(body);
      if (plain.length <= w) out.push(...inline(body, bold));
      else {
        const wrapped = wrap(plain, w);
        const isBold = /<b>/i.test(body);
        if (isBold) out.push(...BOLD_ON);
        wrapped.forEach((p, i) => { out.push(...toAscii(p)); if (i < wrapped.length - 1) out.push(LF); });
        if (isBold) out.push(...BOLD_OFF);
      }
    } else {
      const plain = stripTags(body);
      const wrapped = wrap(plain, w);
      const isBold = /<b>/i.test(body);
      if (isBold) out.push(...BOLD_ON);
      wrapped.forEach((p, i) => { out.push(...toAscii(p)); if (i < wrapped.length - 1) out.push(LF); });
      if (isBold) out.push(...BOLD_OFF);
    }

    if (bold.on) out.push(...BOLD_OFF);
    if (big) out.push(...SIZE_NORMAL);
    out.push(LF);
  }

  out.push(...ALIGN.L);
  for (let i = 0; i < feed; i++) out.push(LF);
  // Potong parsial (GS V 66 0). Printer tanpa pemotong mengabaikan perintah ini.
  if (opts.cut !== false) out.push(GS, 0x56, 0x42, 0x00);
  return new Uint8Array(out);
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// "192.168.1.50" atau "192.168.1.50:9100" -> { host, port }; selain itu null (dianggap MAC Bluetooth).
export function parseLanAddress(id) {
  const m = String(id || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (!m) return null;
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 9100 };
}
