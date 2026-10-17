# Nota Service HP — Capacitor 7

Aplikasi nota servis HP: riwayat nota, status servis, PDF, ekspor CSV/JSON, kamera/galeri, kontak, berbagi file, dan cetak thermal (perlu uji printer fisik).

## Build APK melalui GitHub
1. Ekstrak ZIP ini di komputer/HP.
2. Buat repository GitHub baru.
3. Upload **isi folder** `NotaServiceHP-Capacitor` ke repository (bukan file ZIP-nya saja). Pastikan `.github/workflows/build-apk.yml` ikut ter-upload.
4. Buka tab **Actions** → **Build APK** → **Run workflow**.
5. Setelah workflow selesai, buka hasil run dan unduh artifact `NotaServiceHP-debug-apk`. Ekstrak artifact untuk mengambil `app-debug.apk`.

Jika GitHub web tidak menampilkan pilihan upload folder, buka repo → **Add file → Upload files**, lalu seret file/folder proyek yang sudah diekstrak. Untuk folder tersembunyi seperti `.github`, pastikan workflow ikut masuk; cara paling andal adalah memakai GitHub Desktop atau `git push`.

## Build lokal
Membutuhkan Node.js 20, JDK 21, dan Android SDK:
```sh
npm install --legacy-peer-deps
npm run android:add   # hanya pertama kali
npm run android:sync  # setelah perubahan kode
```

## Catatan penting
- Kode plugin Capacitor (Camera, Filesystem, Share, Contacts) sekarang dibundle dari package resmi Capacitor, bukan mengandalkan `Capacitor.Plugins`.
- Password/pola perangkat tidak ditampilkan di nota pelanggan dan tidak diekspor ke CSV/backup. Informasi yang sudah tersimpan di database lokal lama tidak otomatis terhapus.
- Izin Bluetooth di manifest bukan jaminan semua printer kompatibel. Cetak thermal memakai plugin native buatan sendiri (`EscPosPrinter`, lihat bagian di bawah); uji pairing, cetak 58/80 mm, dan Android 12+ pada printer fisik sebelum dipakai harian.
- APK workflow adalah debug APK, bukan build rilis Play Store.

## Kirim gambar nota langsung ke WhatsApp pelanggan
Tombol **WA Gambar** memakai plugin native `WhatsAppShare` (`scripts/native/WhatsAppSharePlugin.java`).
Plugin ini disalin ke proyek Android dan didaftarkan di `MainActivity` otomatis oleh `scripts/patch-android.js`
(jalan di workflow GitHub setelah `npx cap add android`). Chat pelanggan terbuka dengan gambar siap kirim;
tombol kirim tetap ditekan manual. Jika WhatsApp tidak terpasang, aplikasi kembali memakai menu bagikan biasa.
Fitur ini memakai extra `jid` yang tidak resmi didokumentasikan WhatsApp, jadi uji di HP sebelum dipakai harian.

## Nota Servis Langsung & Laporan Keuangan
- Tombol **⚡ NOTA SERVIS LANGSUNG**: untuk servis yang selesai dan langsung diambil (satu nota, tanpa tahap terima/diagnosa/selesai/ambil). Berisi detail perbaikan, sparepart, garansi (hari), modal, dan metode bayar. Nota langsung terkunci dan dianggap lunas.
- **📈 Laporan Keuangan** (menu Riwayat): omzet, modal, laba kotor, DP batal, dan servis berjalan per bulan. Satu servis dihitung satu kali.
- Cetak thermal (dan preview thermal) kini memuat detail perbaikan, sparepart, garansi, dan metode bayar untuk nota langsung; detail perbaikan/diagnosa juga untuk nota selesai/diagnosa.
- Tombol **Simpan Kontak** menyimpan langsung ke phone book (cek duplikat); jika gagal, memakai menu bagikan.

## Kolom wajib
Hanya 4 kolom wajib: **Nama, Merek, Model, Keluhan**. Selain itu opsional (Nomor HP boleh kosong, tetapi jika diisi harus berformat 08xx; tanpa nomor, tombol WhatsApp dan simpan kontak tidak bisa dipakai).
Nama, Merek, Model otomatis berhuruf kapital di awal kata (kata yang sudah memuat huruf besar seperti iPhone atau NFC tidak diubah).

## Update aplikasi tanpa uninstall
- `keystore/debug.keystore` adalah kunci tanda tangan **tetap**; workflow menyalinnya ke runner sebelum build, sehingga semua APK berikutnya bertanda tangan sama.
- `versionCode` otomatis naik di setiap build (`scripts/patch-android.js`).
- Hasilnya: APK baru bisa dipasang **di atas** versi lama dan data nota tetap ada. Syaratnya: file `keystore/debug.keystore` jangan diganti/dihapus dari repository.
- Pemasangan pertama dengan kunci ini tetap memerlukan uninstall APK lama (kuncinya berbeda). **Backup dulu** lewat menu Backup di aplikasi, lalu Restore setelah pasang.
- Sebaiknya repository dibuat **Private**, karena kunci ini ikut tersimpan di dalamnya.

## Estimasi biaya di Diagnosa
- Label biaya mengikuti tahap: **Estimasi Biaya** (Terima, Diagnosa) dan **Biaya Akhir** (Selesai, Ambil, Langsung), termasuk di preview, PDF, WhatsApp, dan cetak thermal.
- Diagnosa punya kolom **Harga Sparepart** dan **Biaya Jasa**; total estimasi dihitung otomatis (masih bisa diubah manual).
- Status baru **Disetujui Pelanggan** (tercatat di timeline).
- Nota diagnosa memuat catatan "estimasi dapat berubah".
- Saat membuat nota Selesai/Ambil dengan biaya berbeda dari estimasi diagnosa, muncul konfirmasi, dan estimasi awal ditampilkan di nota.

## Format nomor & WhatsApp Business
- Nomor boleh diketik/ditempel sebagai `+62 895-3380-1234`, `62895...`, `0895...`, atau `895...`; otomatis menjadi `0895...` (9-14 digit).
- Pengaturan > **Aplikasi WhatsApp untuk kirim gambar**: Otomatis, WhatsApp Business, atau WhatsApp biasa. Pesan teks (wa.me) dibuka oleh aplikasi WhatsApp bawaan HP.

## Preview thermal
- Preview kini memakai pembangun teks yang sama dengan cetak asli (detail perbaikan, garansi, rincian, DP/sisa, catatan estimasi ikut tampil).
- Tombol **🖨️ Cetak via Bluetooth** tersedia langsung di jendela preview.

## Klaim Garansi, Menunggu Sparepart, Nota Penjualan
- **🛡️ Klaim Garansi**: tombol di atas form. Isi No. Nota asal (nomor nota tahap mana pun) atau No. HP lalu tekan **Cek**: data pelanggan terisi dan status garansi (sisa hari / habis) ditampilkan. Klaim berjalan lewat alur biasa (Terima > Diagnosa > Selesai > Ambil), ditandai di nota dan laporan.
- **Garansi (hari)** kini ada di tahap Selesai (dan Servis Langsung). Garansi dihitung dari tanggal unit diambil, dan tercetak di nota Ambil.
- **Diagnosa**: status baru *Menunggu Sparepart* dan *Sedang Dikerjakan*; tombol **🔄 Update Status / Sparepart** pada nota diagnosa membuat catatan baru di timeline tanpa mengulang data. Laporan menghitung servis yang menunggu sparepart.
- **🛍️ Nota Penjualan**: daftar barang (nama, jumlah, harga, modal), total dan modal dihitung otomatis, satu nota langsung lunas dan terkunci. Nama pelanggan dan nomor HP opsional (bawaan "Pelanggan Umum").
- Laporan Keuangan memisahkan hitungan servis, penjualan, dan klaim; CSV laporan punya kolom Jenis.

## Pembukuan lengkap (Laporan & Pembukuan)
Menu Riwayat > **📈 Laporan & Pembukuan**. Periode bisa **Harian / Bulanan / Tahunan**.
- **Laba / Rugi**: omzet, modal, laba kotor, pengeluaran operasional, dan **laba bersih**.
- **Pengeluaran**: catat sewa, listrik/internet, gaji, transport, pulsa/alat kerja, lain-lain, dan **Beli Stok/Sparepart** (tanggal, jumlah, metode bayar). Bisa dihapus. Ikut Backup/Restore.
  - "Beli Stok/Sparepart" hanya masuk arus kas dan **tidak mengurangi laba**, karena modalnya sudah dicatat di tiap nota (menghindari hitung ganda).
- **DP servis batal**: pilih *Refund* (keluar dari kas, tidak mempengaruhi laba) atau *Hangus* (jadi pendapatan toko).
- **Arus Kas**: kas masuk/keluar menurut **tanggal uang diterima** (DP dihitung saat DP dibayar, pelunasan saat unit diambil), plus rekap saldo per metode **Tunai / Transfer / QRIS** untuk dicocokkan dengan laci dan rekening.
- **Piutang / servis berjalan**: daftar servis yang belum diambil beserta DP dan sisa tagihan.
- **Ekspor**: Laporan PDF periode terpilih, Buku Kas CSV (dengan saldo berjalan), dan CSV per servis.
- Catatan: metode bayar DP dianggap sama dengan metode pelunasan karena nota hanya menyimpan satu metode bayar.
- Database naik ke versi 9 (store baru `pengeluaran`). Update dari versi lama otomatis dan data nota tetap ada.

## Pembaruan pembukuan lanjutan (Tahap 1–3)

Versi kerja ini menambahkan modul lokal berikut:

- **Buku pembayaran terpisah**: tanggal, ID servis, nominal, metode (Tunai/Transfer/QRIS/Lain-lain), pembayaran masuk/refund, dan transaksi pembalik untuk koreksi. Pembayaran manual **bersifat tambahan** di atas DP & pelunasan yang sudah tercatat di nota (misalnya pelanggan melunasi kurang bayar, refund, koreksi) dan masuk ke buku kas serta perhitungan sisa tagihan apabila `serviceId` cocok. Jangan memasukkan ulang DP/pelunasan yang sudah ada di nota.
- **Saldo awal** per Tunai, Transfer, QRIS, dan Lain-lain. Nilai disimpan lokal dan ikut backup.
- **Persediaan sparepart**: kini berupa modul lengkap, lihat bagian *Manajemen Sparepart (v15)* di bawah.
- **Audit log** untuk simpan/perbarui nota, pembayaran, koreksi pembayaran, perubahan saldo awal, stok, pengeluaran, dan gabung backup.
- **Pengingat backup** saat aplikasi dibuka apabila belum ada backup selama 7 hari; backup lengkap mencakup nota, pengeluaran, pembayaran, inventori, audit, dan saldo awal. Android akan meminta pengguna menyimpan/membagikan file, tidak mengunggah diam-diam.
- **Pengingat servis berjalan**: panel menampilkan servis berjalan, umur servis, dan sisa estimasi.
- **Pemindahan data antarperangkat**: backup lengkap dapat digabung melalui impor pada perangkat kedua; data dengan ID sama diperbarui. Buat backup dahulu sebelum menggabungkan.
- **IndexedDB v10**: menambah store `pembayaran`, `inventori`, dan `audit` tanpa menghapus store nota/pengeluaran lama.

### Batasan yang harus diketahui

1. Sinkronisasi otomatis real-time antar-HP **belum aktif**. UI menyimpan konfigurasi URL/key Supabase sebagai persiapan saja; belum ada autentikasi, API sinkronisasi, konflik data, atau kebijakan akses yang aman. Jangan menganggap pengisian URL/key sebagai sinkronisasi aktif dan jangan pernah memasukkan `service_role` key di aplikasi.
2. Backup otomatis ke cloud belum tersedia; aplikasi hanya memberi pengingat dan membuka dialog berbagi/menyimpan backup. Pengunggahan ke Drive perlu dilakukan pengguna atau diintegrasikan dengan provider OAuth yang aman.
3. Pengingat servis saat ini tampil di dalam aplikasi ketika dibuka, bukan notifikasi Android terjadwal di latar belakang.
4. Buku pembayaran baru tidak mengubah otomatis status workflow servis. Untuk menghubungkan pembayaran, masukkan ID servis yang sama persis dengan ID pada riwayat. Data nota lama tanpa entri buku pembayaran tetap menggunakan perhitungan DP/pelunasan lama.
5. Pemotongan stok hanya terjadi pada sparepart yang dipilih lewat pemilih **🔩 Sparepart dari Stok** (atau dipilih dari stok di Nota Penjualan). Sparepart yang hanya diketik manual tidak memengaruhi stok.
6. Build APK belum berhasil diverifikasi dalam lingkungan ini karena dependensi npm (termasuk `html2canvas`) belum tersedia dan `npm install` tidak selesai. Jalankan `npm install`, lalu `npm run build:web` dan verifikasi workflow GitHub Actions sebelum dipakai produksi.

### Tes sebelum dipakai untuk transaksi nyata

- Backup, lalu restore di instalasi uji dan pastikan nota/pengeluaran/pembayaran/stok/audit kembali.
- Catat DP, pembayaran tambahan, dan pelunasan sebagai transaksi terpisah dengan ID servis yang sama; pastikan buku kas tidak menggandakan transaksi legacy.
- Catat pembayaran dengan metode berbeda dan cocokkan total Tunai/Transfer/QRIS dengan uang/rekening nyata.
- Uji transaksi pembalik pembayaran dan pastikan audit menyimpan jejak transaksi asal.
- Uji upgrade dari database lama ke IndexedDB v10 pada salinan data terlebih dahulu.


## Manajemen Sparepart (v15)

Buka dari **Riwayat → 📦 Manajemen Sparepart**. (Panel **🧾 Keuangan Lanjutan** juga kini punya tombol di Riwayat; pada versi sebelumnya panel ini tidak memiliki wadah/tombol di `index.html` sehingga tidak bisa dibuka.)

- **Master barang**: nama, SKU, kategori, cocok untuk (model HP), lokasi rak, supplier, modal/unit, harga jual, stok minimum. Edit, arsip (riwayat tetap tersimpan, bisa diaktifkan lagi), pencarian, dan filter Menipis / Habis / Arsip. Ada penanda **MENIPIS** / **HABIS** dan margin per barang.
- **Kartu stok**: setiap perubahan stok tercatat (stok awal, barang masuk, dipakai nota, penyesuaian) lengkap dengan saldo. Stok hanya berubah lewat jalur ini.
- **➕ Barang masuk**: modal per unit dihitung ulang sebagai **rata-rata tertimbang**. Opsional dicatat juga sebagai pengeluaran *Beli Stok/Sparepart* (masuk arus kas, tidak mengurangi laba, sama seperti aturan pembukuan yang sudah ada). Matikan centang bila pembelian sudah Anda catat manual agar tidak ganda.
- **± Opname**: isi stok fisik, selisih dicatat beserta alasan (hitung fisik, rusak, hilang, retur).
- **Terhubung ke nota**:
  - Form **Diagnosa / Selesai / Servis Langsung** punya pemilih *🔩 Sparepart dari Stok*. Diagnosa hanya estimasi (mengisi harga sparepart dari harga jual); pilihan dari Diagnosa otomatis terisi lagi saat lanjut ke Selesai.
  - Stok dipotong saat nota **Selesai** atau **Servis Langsung** disimpan, dan modal sparepart terisi otomatis dari modal stok (masih bisa diubah).
  - **Nota Penjualan**: tiap baris bisa mengambil barang dari stok (nama, harga jual, modal terisi otomatis).
  - Jika stok kurang, muncul konfirmasi; stok dikurangi paling banyak sampai 0 dan selisih dicatat di kartu stok.
  - Bila nota dibuka lagi lewat **Kembali Edit** lalu disimpan ulang, nota yang sama **diperbarui** (tidak lagi membuat nota baru/duplikat, rantai tahap dan timeline tetap), dan stok lama dikembalikan dulu sebelum dipotong ulang.
  - Bila servis **dibatalkan** di tahap Ambil/Batal, muncul pilihan mengembalikan sparepart yang sudah terpotong ke stok (pilih Batal bila sparepart sudah terpasang).
  - Pemilih sparepart punya kolom **🔎 cari** (nama, SKU, model, kategori); bila hasil tinggal satu, otomatis terpilih.
- **Ekspor Stok CSV**, dan data stok serta kartu stok ikut **Backup / Restore / Gabung data**.
- **IndexedDB v11**: menambah store `stokmutasi`. Update dari versi lama otomatis; data lama (termasuk stok Tahap 2) tetap terbaca.

### Catatan
- Stok yang sudah ada dari versi sebelumnya tidak punya riwayat mutasi; kartu stoknya mulai dari perubahan pertama setelah update. Lakukan **± Opname** sekali bila ingin saldo awalnya tercatat.
- Nota lama tidak dipotong stoknya secara retroaktif.
- Diuji di lingkungan pengembangan: logika stok (potong, kurang stok, edit ulang, rata-rata modal) dan alur UI dasar. Build APK dan pengujian di HP tetap perlu dilakukan seperti biasa.

## Cetak thermal langsung (ESC/POS native)
Nota dicetak langsung ke printer thermal **tanpa aplikasi perantara** (tidak perlu RawBT dan sejenisnya).

- **Plugin native**: `scripts/native/EscPosPrinterPlugin.java` — dikirim ke proyek Android dan didaftarkan di `MainActivity` otomatis oleh `scripts/patch-android.js`. Plugin ini hanya mengurus koneksi + mengirim byte; tidak ada dependensi Cordova pihak ketiga lagi.
- **Encoder ESC/POS**: `src/escpos.js` mengubah teks nota (`[L]`/`[C]`/`[R]`, `<b>`, `<font size='big'>`) menjadi byte ESC/POS, dengan pembungkusan baris sesuai lebar kertas (58 mm = 32 karakter, 75/80 mm = 48 karakter), lalu potong kertas.
- **Transport**:
  - **Bluetooth Classic (SPP)** — printer harus sudah di-*pairing* di Pengaturan Bluetooth HP. Ini mayoritas printer thermal portabel 58 mm.
  - **LAN/WiFi** — isi ID printer dengan IP, mis. `192.168.1.50` atau `192.168.1.50:9100` (port bawaan 9100).
- **Cara pakai**: Pengaturan Printer Thermal → **Pilih Printer Bluetooth** (ketuk printer) atau isi ID manual → **Tes Cetak**. Setelah itu tombol cetak/Auto print langsung mengirim ke printer. Bila belum ada printer tersimpan, aplikasi memakai printer ter-pairing (menanyakan bila lebih dari satu).
- **Izin**: Android 12+ meminta izin *Perangkat sekitar* (Bluetooth) saat pertama kali.
- **Batasan**: belum mendukung printer **BLE-only** (tanpa SPP), printer **USB**, cetak logo/gambar, dan karakter non-ASCII (diganti `?`; aksen dihilangkan).
- **Bila cetakan terpotong/acak**: sesuaikan `CHUNK_SIZE`, `CHUNK_DELAY_MS`, `MIN_FLUSH_WAIT_MS` di `EscPosPrinterPlugin.java`. Bila printer tidak punya pemotong, perintah potong diabaikan dan kertas hanya maju 4 baris.

## Perbaikan pembukuan (v18)
- **Kas tidak lagi berkurang saat ada pembayaran manual.** Sebelumnya, satu saja pembayaran manual untuk sebuah servis membuat DP dan pelunasan dari nota servis itu hilang dari buku kas. Kini DP/pelunasan nota selalu dihitung, dan pembayaran manual ditambahkan di atasnya.
  - **Penting bila sudah ada data lama:** jika Anda pernah menginput pembayaran manual yang menyalin DP/pelunasan nota, nominal itu kini terhitung dua kali. Batalkan lewat tombol ↩️ di Keuangan Lanjutan.
- **Kurang bayar saat ambil (piutang).** Nota Ambil dan Servis Langsung punya kolom *Kurang bayar saat diambil*. Pelunasan di kas hanya sebesar yang benar-benar dibayar; sisanya tercatat sebagai **piutang** (kartu di Laporan, daftar di Keuangan Lanjutan, kolom di CSV). Saat pelanggan melunasi, catat sebagai pembayaran manual dengan ID servis yang sama; piutang berkurang otomatis. Omzet/laba tetap diakui saat barang diambil.
- Logika kas/piutang ada di `src/finance.js` (modul murni, sudah diuji di Node).

## Perbaikan tampilan nota pelanggan (v19)
- **Estimasi waktu** (mis. "1-2 hari") kini tampil di nota Terima/Diagnosa, juga di cetak thermal.
- **Cap status bayar**: nota Ambil, Servis Langsung, dan Penjualan menampilkan **LUNAS** atau **BELUM LUNAS + jumlah kurang bayar** (juga di thermal). Baris "Dibayar saat ambil" selalu tampil bila ada DP/kurang bayar.
- Nota Terima/Diagnosa memakai label **Estimasi Sisa** (bukan "Sisa Pembayaran") karena angkanya masih estimasi.
- Judul **Syarat & Ketentuan** dipisah dari poin pertama; huruf dibesarkan ke 11px agar terbaca.
- Watermark tetap "SERVICE HP" dihapus (bukan nama toko dan menimpa teks di gambar WhatsApp).
- Timeline tanpa detik dan tidak patah baris.

## Perbaikan akses sparepart & keandalan simpan nota (v20)
- Tombol **📦 Sparepart** kini ada di header halaman utama (sebelumnya hanya di bagian bawah layar Riwayat).
- **Simpan nota yang gagal tidak lagi tampak berhasil**: bila database menolak menyimpan, form tetap terbuka (data tidak hilang) dan muncul pesan `❌ Nota GAGAL disimpan: <alasan>`.
- `window.app` dipasang sebelum inisialisasi database; bila init gagal, tombol tetap hidup dan muncul pesan `⚠️ Gagal memuat data: <alasan>` (sebelumnya semua tombol mati tanpa keterangan).
- Pesan galat pada `buatPreview` kini menampilkan penyebab aslinya.

## Perbaikan pergantian pelanggan (v21)
- **Bug:** setelah menekan "Lanjut ke Diagnosa/Selesai/Ambil", lalu pindah tab ke **Terima** untuk pelanggan baru, data pelanggan lama tetap terisi dan nota baru ikut menempel ke servis pelanggan lama (laporan dan kas bisa tercampur).
- **Perbaikan:** pindah ke tab Terima/Langsung/Penjualan saat sedang "lanjut" kini mengosongkan form; nota Terima/Langsung/Penjualan tidak pernah menyambung ke servis lama; `resetForm` ikut membersihkan penanda lanjutan.
- **Data lama:** nota Terima/Langsung/Penjualan yang terlanjur menempel ke servis lain kini dipisah otomatis saat laporan dihitung (data di database tidak diubah). Bila pelanggan itu sempat dilanjutkan ke Diagnosa/Selesai/Ambil sebelum perbaikan ini, tahap lanjutannya mungkin masih perlu dicek manual di Riwayat.

## Sistem Trial & Aktivasi (v22)

- **Trial**: maksimal **100 transaksi** (nota yang disimpan).
- Setelah batas tercapai, tombol simpan nota dikunci dan muncul dialog aktivasi.
- **SN** dibuat otomatis per perangkat (tersimpan di localStorage).
- **Kode aktivasi** digenerate dari SN dengan algoritma yang sama di keygen.
- Setelah aktivasi berhasil, full version aktif selamanya di perangkat tersebut.
- Status trial / full version tampil di header aplikasi.
- Form aktivasi juga bisa dibuka dari **Pengaturan → Lisensi / Aktivasi**.

> Ganti nilai `SECRET` di `src/app.js` (dan di keygen) jika ingin kunci yang berbeda.

## Enkripsi Data AES-256-GCM (v22)

- **Algoritma**: AES-256-GCM (Web Crypto API)
- **Kunci**: diturunkan dari PIN toko lewat PBKDF2-SHA256 (120.000 iterasi)
- **Cakupan**: nota, pengeluaran, pembayaran, inventori, audit, stok, dan file backup
- **PIN**: diset di Pengaturan → Enkripsi Data. Saat app dibuka (jika enkripsi aktif), PIN diminta dulu.
- **Backup**: otomatis terenkripsi jika enkripsi aktif (`Backup_Encrypted_*.json`). Restore backup terenkripsi membutuhkan PIN yang sama.
- Kunci hanya ada di **memori** selama sesi; tidak disimpan ke disk.
- Modul: `src/crypto.js`

> Jangan lupa PIN. Tanpa PIN, data terenkripsi tidak bisa dibuka.

## Build Debug vs Release

| Jenis | Artifact | Kegunaan |
|-------|----------|----------|
| **Debug** | `NotaServiceHP-debug-apk` | Uji coba, development |
| **Release** | `NotaServiceHP-release-apk` | Bagikan ke pelanggan / install harian |

### Lewat GitHub Actions
1. Tab **Actions** → **Build APK** → **Run workflow**
2. Pilih **build_type**: `both` / `debug` / `release`
3. Unduh artifact yang sesuai

### Keystore release
- File: `keystore/release.keystore`
- Alias default: `notaservicehp`
- Password default: `NotaHP2026Release` (sama store & key)

Untuk keamanan lebih baik, set GitHub Secrets:
- `RELEASE_STORE_PASSWORD`
- `RELEASE_KEY_PASSWORD`
- `RELEASE_KEY_ALIAS`

> **Penting:** simpan keystore release. Kalau hilang, update APK ke HP pelanggan yang sudah install bisa gagal (harus uninstall dulu).

### Lokal
```sh
npm run android:add   # pertama kali
npm run apk           # debug
npm run apk:release   # release (butuh android/ sudah ada + keystore)
```
