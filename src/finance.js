// Perhitungan kas & piutang murni (tanpa DOM/penyimpanan) — bisa diuji di Node.
//
// Model data:
//  - Servis (hasil groupServis): { id, total, dpAmt, dpTs, ts, status: 'proses'|'diambil'|'batal', jenis, kurang }
//      kurang = jumlah yang BELUM dibayar pelanggan saat barang diambil (piutang awal), hanya bermakna bila status 'diambil'.
//  - Pembayaran manual (ledger): { serviceId, date, amount, kind: 'masuk'|'refund', method }
//
// Aturan: pembayaran manual selalu BERSIFAT TAMBAHAN terhadap DP & pelunasan yang tercatat di nota.
// (Dulu, satu pembayaran manual membuat DP/pelunasan nota hilang dari buku kas.)

/** Total bersih pembayaran manual untuk satu servis (masuk - refund). */
export function ledgerNet(payments, serviceId) {
  let net = 0;
  for (const p of payments || []) {
    if (p.serviceId !== serviceId) continue;
    net += p.kind === 'masuk' ? Number(p.amount) || 0 : -(Number(p.amount) || 0);
  }
  return net;
}

/** Uang yang sudah diterima untuk servis yang masih berjalan: DP + pembayaran manual bersih. */
export function paidSoFar(s, payments) {
  return Math.max(0, (Number(s.dpAmt) || 0) + ledgerNet(payments, s.id));
}

/** Kekurangan bayar servis yang sudah diambil, setelah dikurangi pembayaran manual yang masuk belakangan. */
export function piutangOf(s, payments) {
  if (s.status !== 'diambil') return 0;
  return Math.max(0, (Number(s.kurang) || 0) - ledgerNet(payments, s.id));
}

/** Jumlah yang dibayar saat barang diambil (pelunasan nota) = total - DP - kurang bayar. */
export function pelunasanAmount(s) {
  return Math.max((Number(s.total) || 0) - (Number(s.dpAmt) || 0) - (Number(s.kurang) || 0), 0);
}

/**
 * Kejadian kas yang berasal dari nota (DP, pelunasan, refund DP batal).
 * @param s    servis
 * @param opts { refundDp: boolean, dKey: (ts)=>'YYYY-MM-DD' }
 * @returns [{ tgl, jenis, masuk, keluar }]
 */
export function notaKasEvents(s, { refundDp, dKey }) {
  const ev = [];
  if (s.dpAmt > 0 && s.dpTs) ev.push({ tgl: dKey(s.dpTs), jenis: 'DP', masuk: s.dpAmt, keluar: 0 });
  if (s.status === 'diambil') {
    const bayar = pelunasanAmount(s);
    if (bayar > 0) ev.push({ tgl: dKey(s.ts), jenis: s.jenis === 'jual' ? 'Penjualan' : (s.dpAmt > 0 ? 'Pelunasan' : 'Servis'), masuk: bayar, keluar: 0 });
  } else if (s.status === 'batal' && refundDp && s.dpAmt > 0) {
    ev.push({ tgl: dKey(s.ts), jenis: 'Refund DP', masuk: 0, keluar: s.dpAmt });
  }
  return ev;
}
