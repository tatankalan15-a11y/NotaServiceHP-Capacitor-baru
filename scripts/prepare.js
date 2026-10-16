// Menyalin library PDF/gambar lokal agar aplikasi tidak membutuhkan CDN.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = [
  ['node_modules/html2canvas/dist/html2canvas.min.js', 'www/libs/html2canvas.min.js'],
  ['node_modules/jspdf/dist/jspdf.umd.min.js', 'www/libs/jspdf.umd.min.js'],
];
for (const [from, to] of files) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  if (!fs.existsSync(src)) {
    console.error(`File tidak ditemukan: ${from}. Jalankan npm install terlebih dahulu.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`OK ${to}`);
}
