import { Capacitor, registerPlugin } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Contacts } from '@capacitor-community/contacts';
import { tagsToEscPos, bytesToBase64, parseLanAddress } from './escpos.js';
import { ledgerNet, paidSoFar, piutangOf, notaKasEvents } from './finance.js';
import {
    encryptObject, decryptObject, setupEncryption, unlockWithPin,
    encryptBackupPayload, decryptBackupPayload, isEncryptedRecord, cryptoAvailable
} from './crypto.js';
import {
    generateSNFromToko as genSNFromToko,
    generateActivationCode as genActivationCode,
    isValidActivation as checkActivation,
    signLicenseBlob,
    verifyLicenseBlob,
    LICENSE_SECRET,
    LICENSE_PREFIX,
    LICENSE_TRIAL_LIMIT
} from './license-crypto.js';

// Plugin native kustom (android/.../WhatsAppSharePlugin.java) untuk kirim gambar langsung ke chat nomor tertentu
const WhatsAppShare = registerPlugin('WhatsAppShare');
// Plugin native kustom (android/.../EscPosPrinterPlugin.java) untuk cetak ESC/POS langsung via Bluetooth SPP / LAN, tanpa aplikasi lain
const EscPosPrinter = registerPlugin('EscPosPrinter');


    // ============================================
    // APLIKASI UTAMA
    // ============================================
    const app = (function() {
        // Helper Capacitor
        const CHAIN_TYPES = ['diagnosa', 'selesai', 'ambil']; // hanya tahap lanjutan yang boleh menyambung ke servis lama
        function isCapacitor() {
            return typeof Capacitor !== 'undefined' && (typeof Capacitor.isNativePlatform === 'function' ? Capacitor.isNativePlatform() : (Capacitor.getPlatform && Capacitor.getPlatform() !== 'web'));
        }
        // Capacitor 7: akses plugin melalui package import, bukan Capacitor.Plugins.
        function getPlugin(name) {
            if (!isCapacitor()) return null;
            const plugins = { Camera, Filesystem, Share, Contacts, WhatsAppShare, EscPosPrinter };
            return plugins[name] || null;
        }

        function blobToB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }
        function textToB64(t) { return btoa(unescape(encodeURIComponent(t))); }
        async function shareFile(name, b64, mime, title) {
            const FS = getPlugin('Filesystem'), Share = getPlugin('Share');
            if (!FS || !Share) throw new Error('Plugin Filesystem/Share tidak tersedia');
            const w = await FS.writeFile({ path: name, data: b64, directory: 'CACHE' });
            await Share.share({ title, files: [w.uri], dialogTitle: title });
        }

        // ============================================
        // SISTEM TRIAL & AKTIVASI (HMAC-SHA256)
        // SECRET & algoritma di src/license-crypto.js
        // ============================================
        const LICENSE = {
            TRIAL_LIMIT: LICENSE_TRIAL_LIMIT,
            SECRET: LICENSE_SECRET,
            PREFIX: LICENSE_PREFIX
        };

        /** SN digenerate dari Nama Toko + Alamat + Telepon (HMAC-SHA256). */
        function generateSNFromToko(nama, alamat, telepon) {
            return genSNFromToko(nama, alamat, telepon);
        }

        function generateSN() {
            const nama = (tokoSettings && tokoSettings.nama) || '';
            const alamat = (tokoSettings && tokoSettings.alamat) || '';
            const telepon = (tokoSettings && tokoSettings.telepon) || '';
            return generateSNFromToko(nama, alamat, telepon);
        }

        function generateActivationCode(sn) {
            return genActivationCode(sn);
        }

        function isValidActivation(sn, code) {
            return checkActivation(sn, code);
        }

        /**
         * Baca status lisensi. Signature HMAC diverifikasi.
         * Edit manual localStorage (activated:true) → ditolak.
         * trialUsed bersifat monotoik (tidak turun meski history dihapus).
         */
        function getLicenseStatus() {
            const empty = { activated: false, sn: null, trialUsed: 0, activatedAt: null, sig: null };
            try {
                const raw = localStorage.getItem('nshp_license');
                if (!raw) return { ...empty };
                const st = JSON.parse(raw);
                if (!verifyLicenseBlob(st)) {
                    // Signature invalid → anggap trial saja, pertahankan trialUsed jika angka valid
                    const kept = Math.max(0, parseInt(st.trialUsed, 10) || 0);
                    return { activated: false, sn: st.sn || null, trialUsed: kept, activatedAt: null, sig: null, tampered: true };
                }
                return {
                    activated: !!st.activated,
                    sn: st.sn || null,
                    trialUsed: Math.max(0, parseInt(st.trialUsed, 10) || 0),
                    activatedAt: st.activatedAt || null,
                    sig: st.sig
                };
            } catch (_) {
                return { ...empty };
            }
        }

        function saveLicenseStatus(status) {
            try {
                const blob = {
                    sn: status.sn || null,
                    activated: !!status.activated,
                    trialUsed: Math.max(0, parseInt(status.trialUsed, 10) || 0),
                    activatedAt: status.activatedAt || null
                };
                blob.sig = signLicenseBlob(blob);
                localStorage.setItem('nshp_license', JSON.stringify(blob));
            } catch (_) {}
        }

        /**
         * Sinkronkan SN dengan data toko. Ganti data toko → aktivasi hangus.
         * trialUsed tidak di-reset.
         */
        function ensureSN() {
            const newSn = generateSN();
            let st = getLicenseStatus();
            if (st.sn !== newSn) {
                const wasActivated = !!st.activated && !st.tampered;
                st.sn = newSn;
                st.activated = false;
                st.activatedAt = null;
                saveLicenseStatus(st);
                if (wasActivated) {
                    try { showToast('⚠️ Data toko berubah → SN baru. Silakan aktivasi ulang.'); } catch (_) {}
                }
            } else if (!st.sn) {
                st.sn = newSn;
                saveLicenseStatus(st);
            }
            return st.sn;
        }

        function isActivated() {
            const st = getLicenseStatus();
            return !!st.activated && !st.tampered && verifyLicenseBlob({ ...st, sig: st.sig });
        }

        /** Jumlah trial yang sudah terpakai (monotoik, tidak turun jika history dihapus). */
        function getTrialUsed() {
            const st = getLicenseStatus();
            const fromHistory = (historyData && historyData.length) || 0;
            return Math.max(st.trialUsed | 0, fromHistory);
        }

        /**
         * Naikkan counter trial bila history bertambah.
         * Dipanggil setelah simpan nota / load data.
         */
        function syncTrialCounter() {
            const st = getLicenseStatus();
            const used = getTrialUsed();
            if (used > (st.trialUsed | 0)) {
                st.trialUsed = used;
                // Pertahankan activated hanya jika signature masih valid
                if (st.tampered) {
                    st.activated = false;
                    st.activatedAt = null;
                }
                saveLicenseStatus(st);
            }
        }

        function getTransactionCount() {
            return getTrialUsed();
        }

        function canCreateNota() {
            if (isActivated()) return true;
            return getTrialUsed() < LICENSE.TRIAL_LIMIT;
        }

        function getRemainingTrial() {
            if (isActivated()) return Infinity;
            return Math.max(0, LICENSE.TRIAL_LIMIT - getTrialUsed());
        }

        function updateLicenseUI() {
            const el = document.getElementById('licenseStatus');
            if (el) {
                if (isActivated()) {
                    el.innerHTML = '✅ Full Version';
                    el.style.color = '#4caf50';
                } else {
                    const sisa = getRemainingTrial();
                    el.innerHTML = '⏳ Trial: ' + sisa + ' transaksi tersisa';
                    el.style.color = sisa < 20 ? '#f44336' : '#ff9800';
                }
            }
            // Sinkronkan juga di halaman Pengaturan (jika terbuka)
            const sn = getLicenseStatus().sn || ensureSN();
            const snEl = document.getElementById('settingSN');
            if (snEl) snEl.value = sn || '';
            const stEl = document.getElementById('settingLicenseStatus');
            if (stEl) {
                if (isActivated()) {
                    stEl.innerHTML = '✅ Status: <span style="color:#4caf50;">Full Version</span>';
                } else {
                    const sisa = getRemainingTrial();
                    stEl.innerHTML = '⏳ Status: Trial — <b>' + sisa + '</b> transaksi tersisa';
                }
            }
        }

        function showActivationDialog() {
            ensureSN();
            const st = getLicenseStatus();
            const snEl = document.getElementById('actSN');
            const codeEl = document.getElementById('actCode');
            if (snEl) snEl.value = st.sn || '';
            if (codeEl) codeEl.value = '';
            const modal = document.getElementById('activationModal');
            if (modal) modal.classList.add('active');
        }

        function closeActivation() {
            const modal = document.getElementById('activationModal');
            if (modal) modal.classList.remove('active');
        }

        function doActivate() {
            const sn = ((document.getElementById('actSN') || {}).value || '').trim();
            const code = ((document.getElementById('actCode') || {}).value || '').trim();
            if (!isValidActivation(sn, code)) {
                showToast('❌ Kode aktivasi salah');
                return;
            }
            // SN di form harus cocok dengan SN toko saat ini
            const currentSn = generateSN();
            if (sn.replace(/[^A-Z0-9]/gi, '').toUpperCase() !== currentSn.replace(/[^A-Z0-9]/gi, '').toUpperCase()) {
                showToast('❌ SN tidak cocok dengan data toko saat ini');
                return;
            }
            const st = getLicenseStatus();
            st.sn = currentSn;
            st.activated = true;
            st.activatedAt = new Date().toISOString();
            st.trialUsed = getTrialUsed();
            saveLicenseStatus(st); // menulis signature HMAC
            closeActivation();
            showToast('✅ Berhasil diaktivasi! Full version aktif.');
            updateLicenseUI();
        }

        // ---- Enkripsi data (AES-256-GCM + PIN) ----
        function showPinLock(mode) {
            // mode: 'unlock' | 'setup' | 'change'
            const modal = document.getElementById('pinLockModal');
            if (!modal) return;
            modal.dataset.mode = mode || 'unlock';
            const title = document.getElementById('pinLockTitle');
            const hint = document.getElementById('pinLockHint');
            const pin2wrap = document.getElementById('pinConfirmWrap');
            if (title) title.textContent = mode === 'setup' ? '🔐 Aktifkan Enkripsi Data' : (mode === 'change' ? '🔐 Ganti PIN Enkripsi' : '🔐 Buka Kunci Data');
            if (hint) hint.textContent = mode === 'setup'
                ? 'Buat PIN (min. 4 digit). PIN ini dipakai untuk mengenkripsi semua nota & backup. Jangan lupa PIN — data tidak bisa dipulihkan tanpa PIN.'
                : (mode === 'change' ? 'Masukkan PIN baru (min. 4 digit). Data akan tetap terenkripsi dengan kunci baru setelah disimpan ulang.' : 'Masukkan PIN enkripsi untuk membuka data toko.');
            if (pin2wrap) pin2wrap.style.display = (mode === 'setup' || mode === 'change') ? 'block' : 'none';
            const p1 = document.getElementById('pinInput');
            const p2 = document.getElementById('pinConfirm');
            if (p1) p1.value = '';
            if (p2) p2.value = '';
            modal.classList.add('active');
            setTimeout(() => { if (p1) p1.focus(); }, 200);
        }
        function closePinLock() {
            const modal = document.getElementById('pinLockModal');
            if (modal) modal.classList.remove('active');
        }
        async function submitPinLock() {
            const modal = document.getElementById('pinLockModal');
            const mode = (modal && modal.dataset.mode) || 'unlock';
            const pin = (document.getElementById('pinInput') || {}).value || '';
            const pin2 = (document.getElementById('pinConfirm') || {}).value || '';
            if (pin.length < 4) { showToast('PIN minimal 4 karakter'); return; }
            if (!cryptoAvailable()) { showToast('Perangkat tidak mendukung Web Crypto'); return; }
            try {
                if (mode === 'setup' || mode === 'change') {
                    if (pin !== pin2) { showToast('Konfirmasi PIN tidak cocok'); return; }
                    showLoading();
                    const meta = await setupEncryption(pin);
                    saveCryptoMeta(meta);
                    cryptoKey = await unlockWithPin(pin, meta);
                    cryptoUnlocked = true;
                    // Re-save existing data encrypted
                    await reencryptAllData();
                    closePinLock();
                    updateCryptoUI();
                    showToast('✅ Enkripsi data aktif (AES-256-GCM)');
                } else {
                    showLoading();
                    const meta = getCryptoMeta();
                    cryptoKey = await unlockWithPin(pin, meta);
                    cryptoUnlocked = true;
                    closePinLock();
                    await loadHistory();
                    updateCryptoUI();
                    updateLicenseUI();
                    showToast('✅ Data terbuka');
                }
            } catch (e) {
                showToast('❌ ' + ((e && e.message) || 'PIN salah'));
            } finally {
                hideLoading();
            }
        }
        async function reencryptAllData() {
            // Simpan ulang semua data di memori agar tersimpan terenkripsi di IDB
            for (const n of historyData) { try { await saveToDB(n); } catch (_) {} }
            for (const x of expenseData) { try { await saveExpense(x); } catch (_) {} }
            for (const x of paymentData) { try { await putStore('pembayaran', x); } catch (_) {} }
            for (const x of inventoryData) { try { await putStore('inventori', x); } catch (_) {} }
            for (const x of auditData) { try { await putStore('audit', x); } catch (_) {} }
            for (const x of stockMoves) { try { await putStore('stokmutasi', x); } catch (_) {} }
        }
        async function disableEncryption() {
            if (!isEncryptionEnabled()) { showToast('Enkripsi belum aktif'); return; }
            if (!cryptoKey) { showToast('Buka kunci dulu dengan PIN'); showPinLock('unlock'); return; }
            if (!confirm('Nonaktifkan enkripsi? Data akan disimpan ulang dalam bentuk biasa (tidak terenkripsi).')) return;
            showLoading();
            try {
                const keyBackup = cryptoKey;
                // Matikan flag dulu agar maybeEncrypt tidak enkripsi
                const meta = getCryptoMeta() || {};
                meta.enabled = false;
                saveCryptoMeta(meta);
                cryptoKey = null;
                cryptoUnlocked = true;
                // Decrypt all raw and save plaintext
                const rawNotas = await (async () => {
                    if (!db) await initDB();
                    return new Promise((res, rej) => {
                        const tx = db.transaction(['nota'], 'readonly');
                        const req = tx.objectStore('nota').getAll();
                        req.onsuccess = () => res(req.result || []);
                        req.onerror = rej;
                    });
                })();
                // Temporarily restore key only for decrypt
                cryptoKey = keyBackup;
                const plainNotas = await decryptList(rawNotas);
                cryptoKey = null;
                saveCryptoMeta({ enabled: false });
                localStorage.removeItem('nshp_crypto');
                for (const n of plainNotas) {
                    await new Promise((res, rej) => {
                        const tx = db.transaction(['nota'], 'readwrite');
                        tx.objectStore('nota').put(n);
                        tx.oncomplete = res; tx.onerror = rej;
                    });
                }
                await loadHistory();
                updateCryptoUI();
                showToast('Enkripsi dinonaktifkan');
            } catch (e) {
                showToast('Gagal nonaktifkan: ' + (e.message || e));
            } finally { hideLoading(); }
        }
        function updateCryptoUI() {
            const el = document.getElementById('cryptoStatus');
            if (!el) return;
            if (isEncryptionEnabled()) {
                el.innerHTML = cryptoUnlocked
                    ? '🔒 Enkripsi <b style="color:#4caf50;">AKTIF</b> (data terbuka)'
                    : '🔒 Enkripsi <b style="color:#ff9800;">AKTIF</b> — terkunci';
            } else {
                el.innerHTML = '🔓 Enkripsi <b style="color:#888;">nonaktif</b>';
            }
        }
        function enableEncryptionFromSettings() {
            if (!cryptoAvailable()) { showToast('Web Crypto tidak tersedia di perangkat ini'); return; }
            if (isEncryptionEnabled()) { showToast('Enkripsi sudah aktif'); return; }
            showPinLock('setup');
        }
        function changePinFromSettings() {
            if (!isEncryptionEnabled()) { showToast('Aktifkan enkripsi dulu'); return; }
            if (!cryptoUnlocked || !cryptoKey) { showPinLock('unlock'); showToast('Buka kunci dulu, lalu ganti PIN'); return; }
            showPinLock('change');
        }

        // Variabel Global
        let db, currentType = 'terima', currentStatus = 'diambil', currentNota = null;
        let tokoSettings = {}, historyData = [], expenseData = [], logoData = null, qrisData = null;
        let paymentData = [], inventoryData = [], auditData = [], stockMoves = [];
        const ADV_DB_STORES = ['pembayaran','inventori','audit','stokmutasi'];
        let fotoDevicePath = null, fotoDeviceData = null;
        let footers = { terima:{text:'',enabled:false}, diagnosa:{text:'',enabled:false}, selesai:{text:'',enabled:false}, ambil:{text:'',enabled:false} };
        let klaimMode = false; let skText = "", autoWASelesai = false, autoWAAmbil = false, waNotifTemplate = "";
        let lastPrinterId = localStorage.getItem('last_printer_id') || '', autoPrint = false;
        // Enkripsi AES-GCM (kunci hanya di memori saat app terbuka)
        let cryptoKey = null;
        let cryptoUnlocked = false;

        function getCryptoMeta() {
            try {
                const raw = localStorage.getItem('nshp_crypto');
                return raw ? JSON.parse(raw) : null;
            } catch (_) { return null; }
        }
        function saveCryptoMeta(meta) {
            try { localStorage.setItem('nshp_crypto', JSON.stringify(meta)); } catch (_) {}
        }
        function isEncryptionEnabled() {
            const m = getCryptoMeta();
            return !!(m && m.enabled && m.salt && m.verifier);
        }
        async function maybeEncryptForStore(obj) {
            if (!isEncryptionEnabled() || !cryptoKey || !obj) return obj;
            try { return await encryptObject(obj, cryptoKey); } catch (e) {
                console.error('encrypt gagal', e);
                throw new Error('Gagal mengenkripsi data: ' + (e.message || e));
            }
        }
        async function maybeDecryptFromStore(rec) {
            if (!rec) return rec;
            if (!isEncryptedRecord(rec)) return rec;
            if (!cryptoKey) throw new Error('Data terenkripsi — buka kunci dulu dengan PIN');
            return decryptObject(rec, cryptoKey);
        }
        async function decryptList(list) {
            const out = [];
            for (const r of (list || [])) {
                try { out.push(await maybeDecryptFromStore(r)); } catch (e) {
                    console.warn('skip record terenkripsi gagal decrypt', e);
                }
            }
            return out;
        }
        
        // Pattern Lock
        let patternPath = [], patternCanvas = null, patternCtx = null;
        const pointRadius = 15, gridSize = 3;
        let pointPositions = [];

        function initPatternCanvas() {
            patternCanvas = document.getElementById('patternCanvas');
            if (!patternCanvas) return;
            patternCtx = patternCanvas.getContext('2d');
            const size = patternCanvas.width, step = size / (gridSize + 1);
            pointPositions = [];
            for (let row = 0; row < gridSize; row++) {
                for (let col = 0; col < gridSize; col++) {
                    pointPositions.push({ x: step * (col + 1), y: step * (row + 1), index: row * gridSize + col });
                }
            }
            drawPatternCanvas();
            attachPatternEvents();
        }

        function attachPatternEvents() {
            if (!patternCanvas) return;
            const getPoint = (e) => {
                const rect = patternCanvas.getBoundingClientRect();
                const scaleX = patternCanvas.width / rect.width, scaleY = patternCanvas.height / rect.height;
                let cx = e.touches ? e.touches[0].clientX : e.clientX;
                let cy = e.touches ? e.touches[0].clientY : e.clientY;
                const x = (cx - rect.left) * scaleX, y = (cy - rect.top) * scaleY;
                for (let p of pointPositions) {
                    if (Math.sqrt((x-p.x)**2 + (y-p.y)**2) <= pointRadius) return p.index;
                }
                return null;
            };
            let drawing = false;
            const start = (e) => { e.preventDefault(); drawing = true; const i = getPoint(e); if (i !== null && !patternPath.includes(i)) { patternPath.push(i); drawPatternCanvas(); } };
            const move = (e) => { if (!drawing) return; e.preventDefault(); const i = getPoint(e); if (i !== null && !patternPath.includes(i)) { patternPath.push(i); drawPatternCanvas(); } };
            const end = () => { drawing = false; updatePatternOutput(); };
            patternCanvas.addEventListener('mousedown', start);
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', end);
            patternCanvas.addEventListener('touchstart', start);
            window.addEventListener('touchmove', move);
            window.addEventListener('touchend', end);
        }

        function drawPatternCanvas() {
            if (!patternCtx) return;
            patternCtx.clearRect(0, 0, patternCanvas.width, patternCanvas.height);
            patternCtx.fillStyle = '#f0f0f0';
            patternCtx.fillRect(0, 0, patternCanvas.width, patternCanvas.height);
            for (let p of pointPositions) {
                patternCtx.beginPath();
                patternCtx.arc(p.x, p.y, pointRadius, 0, 2 * Math.PI);
                patternCtx.fillStyle = patternPath.includes(p.index) ? '#4caf50' : '#aaa';
                patternCtx.fill();
                patternCtx.strokeStyle = '#333';
                patternCtx.lineWidth = 2;
                patternCtx.stroke();
            }
            if (patternPath.length > 1) {
                patternCtx.beginPath();
                patternCtx.moveTo(pointPositions[patternPath[0]].x, pointPositions[patternPath[0]].y);
                for (let i = 1; i < patternPath.length; i++) patternCtx.lineTo(pointPositions[patternPath[i]].x, pointPositions[patternPath[i]].y);
                patternCtx.strokeStyle = '#4caf50';
                patternCtx.lineWidth = 4;
                patternCtx.stroke();
            }
        }

        function updatePatternOutput() {
            let s = patternPath.join('-');
            document.getElementById('passwordDevice').value = s;
            document.getElementById('patternInfo').innerHTML = s ? `✅ Pola: ${s} (${patternPath.length} titik)` : `🔓 Pola kosong (atau gunakan input teks)`;
            let m = document.getElementById('passwordDeviceText');
            if (m && !m.value.trim()) m.value = s;
        }

        function resetPattern() { patternPath = []; drawPatternCanvas(); updatePatternOutput(); }
        function clearPattern() { patternPath = []; drawPatternCanvas(); updatePatternOutput(); document.getElementById('passwordDeviceText').value = ''; }

        // Utility Functions
        function showToast(msg) { let t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }
        function showLoading() { document.getElementById('loadingOverlay').classList.add('show'); }
        function hideLoading() { document.getElementById('loadingOverlay').classList.remove('show'); }
function escapeHtml(str) { if (str === null || str === undefined) return ''; return String(str).replace(/&(?!(?:amp|lt|gt|quot|#39);)/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
        function unesc(str) { return String(str ?? '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&'); }
        function isSafeImg(src) { return typeof src === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(src); }
        function sanitizeDeep(v) { if (typeof v === 'string') return escapeHtml(v); if (Array.isArray(v)) return v.map(sanitizeDeep); if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = sanitizeDeep(v[k]); return o; } return v; }
        function sanitizeNota(n) {
            if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id) return null;
            const foto = n.fotoDevice; const c = sanitizeDeep({ ...n, fotoDevice: null });
            ['totalBiaya','dp','sisa','modal','estimasiAwal','kurangBayar'].forEach(k => { c[k] = Number(n[k]) || 0; });
            if (foto && typeof foto === 'object') {
                if (foto.type === 'base64' && isSafeImg(foto.data)) c.fotoDevice = { type: 'base64', data: foto.data };
                else if (foto.type === 'file' && typeof foto.path === 'string') c.fotoDevice = { type: 'file', path: escapeHtml(foto.path) };
            }
            return c;
        }
        function capWords(v) { return String(v || '').replace(/\S+/g, w => w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w); }
        function normalizePhone(v) { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('62')) return d; if (d.startsWith('0')) return '62' + d.slice(1); if (d.startsWith('8')) return '62' + d; return d; }
        function csvCell(v) { let t = unesc(v ?? '').toString(); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g,'""') + '"'; }
        function newNotaId() { const d = new Date(), pad = x => String(x).padStart(2,'0'); const base = 'SRV-' + String(d.getFullYear()).slice(2) + pad(d.getMonth()+1) + pad(d.getDate()) + '-'; let id; do { id = base + Math.random().toString(36).slice(2,6).toUpperCase(); } while (historyData.some(h => h.id === id || h.notaId === id)); return id; }
        function formatRupiah(num) { return parseInt(num||0).toLocaleString('id-ID'); }
        function cleanPhoneInput(el) { let v = el.value.replace(/\D/g,''); if (v.startsWith('62')) v = '0'+v.substring(2); if (v.startsWith('+62')) v = '0'+v.substring(3); else if (v.startsWith('8')) v = '0'+v; el.value = v; return v; }
        function validatePhone() { let inp = document.getElementById('nohp'), v = inp.value, valid = v === '' || /^08[1-9]\d{6,11}$/.test(v); inp.classList.toggle('error-input', !valid); document.getElementById('phoneValidation').classList.toggle('show', !valid && v !== ''); return valid; }
        function hitungSisa() { let t = parseFloat(document.getElementById('totalBiaya').value)||0, d = parseFloat(document.getElementById('dp').value)||0, s = t - d; document.getElementById('sisa').value = s > 0 ? s.toLocaleString('id-ID') : '0'; }

        // IndexedDB
        function initDB() {
            return new Promise((resolve, reject) => {
                const r = indexedDB.open('NotaServiceDB', 11);
                r.onerror = (e) => reject(e.target.error);
                r.onblocked = () => reject(new Error('Database sedang dipakai jendela lain. Tutup aplikasi lalu buka lagi.'));
                r.onsuccess = (e) => { db = e.target.result; resolve(db); };
                r.onupgradeneeded = (e) => { const d = e.target.result; if (!d.objectStoreNames.contains('nota')) d.createObjectStore('nota', { keyPath: 'id' }); if (!d.objectStoreNames.contains('pengeluaran')) d.createObjectStore('pengeluaran', { keyPath: 'id' }); if (!d.objectStoreNames.contains('pembayaran')) d.createObjectStore('pembayaran', { keyPath: 'id' }); if (!d.objectStoreNames.contains('inventori')) d.createObjectStore('inventori', { keyPath: 'id' }); if (!d.objectStoreNames.contains('audit')) d.createObjectStore('audit', { keyPath: 'id' }); if (!d.objectStoreNames.contains('stokmutasi')) d.createObjectStore('stokmutasi', { keyPath: 'id' }); };
            });
        }
        async function saveToDB(data) {
            if (!db) await initDB();
            const toStore = await maybeEncryptForStore(data);
            return new Promise((res, rej) => { const tx = db.transaction(['nota'], 'readwrite'), store = tx.objectStore('nota'), req = store.put(toStore); req.onsuccess = res; req.onerror = rej; });
        }
        async function getAllFromDB() {
            if (!db) await initDB();
            const raw = await new Promise((res, rej) => { const tx = db.transaction(['nota'], 'readonly'), store = tx.objectStore('nota'), req = store.getAll(); req.onsuccess = () => res(req.result); req.onerror = rej; });
            return decryptList(raw);
        }
        async function saveToHistory(nota) { try { await saveToDB(nota); const i = historyData.findIndex(h => h.id === nota.id); if (i !== -1) historyData[i] = nota; else historyData.unshift(nota); try { syncTrialCounter(); } catch (_) {} try { await auditLog('Simpan/perbarui nota', `${nota.notaId || nota.id} · ${nota.type || 'servis'} · ${nota.nama || ''}`); } catch (_) {} return true; } catch (e) { console.error('saveToHistory gagal', e); const why = (e && (e.message || (e.target && e.target.error && e.target.error.message))) || 'database tidak bisa diakses'; showToast('❌ Nota GAGAL disimpan: ' + why); return false; } }
        async function loadHistory() { try { historyData = (await getAllFromDB()).map(sanitizeNota).filter(Boolean).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)); } catch (e) { historyData = []; } try { expenseData = (await decryptList(await getAllExpensesRaw())).map(sanitizeExpense).filter(Boolean); } catch (e) { expenseData = []; } try { paymentData = await decryptList(await getAllStoreRaw('pembayaran')); inventoryData = await decryptList(await getAllStoreRaw('inventori')); auditData = await decryptList(await getAllStoreRaw('audit')); stockMoves = await decryptList(await getAllStoreRaw('stokmutasi')); } catch (e) { paymentData=[]; inventoryData=[]; auditData=[]; stockMoves=[]; } try { syncTrialCounter(); } catch (_) {} }

        function validateForm() {
            let v = true;
            if (currentType === 'jual') { if (!bacaItemJual().length) { showToast('Tambahkan minimal 1 barang'); return false; } return validatePhone(); }
            if (!document.getElementById('nama').value.trim()) { document.getElementById('namaError').classList.add('show'); v = false; } else document.getElementById('namaError').classList.remove('show');
            if (!validatePhone()) v = false;
            if (!document.getElementById('merek').value.trim()) { document.getElementById('merekError').classList.add('show'); v = false; } else document.getElementById('merekError').classList.remove('show');
            if (!document.getElementById('model').value.trim()) { document.getElementById('modelError').classList.add('show'); v = false; } else document.getElementById('modelError').classList.remove('show');
            if (!document.getElementById('keluhan').value.trim()) { document.getElementById('keluhanError').classList.add('show'); v = false; } else document.getElementById('keluhanError').classList.remove('show');
            return v;
        }
        function getKondisi() { let a = []; document.querySelectorAll('.kondisi-checkbox.active').forEach(el => a.push(el.dataset.value)); let l = document.getElementById('kondisiLainnya').value.trim(); if (l) a.push(escapeHtml(l)); return a; }

        // ============================================
        // FUNGSI DENGAN PLUGIN CAPACITOR
        // ============================================
        async function handleFotoDevice(input) {
            if (isCapacitor()) {
                const Camera = getPlugin('Camera');
                if (Camera) {
                    try {
                        try { await Camera.requestPermissions({ permissions: ['camera'] }); } catch (e) { console.warn('Izin kamera:', e); }
                        const photo = await Camera.getPhoto({
                            quality: 60,
                            allowEditing: false,
                            resultType: 'dataUrl', width: 1280,
                            source: 'PROMPT', promptLabelHeader: 'Foto device', promptLabelPhoto: 'Dari galeri', promptLabelPicture: 'Ambil foto'
                        });
                        if (photo && photo.dataUrl) {
                            fotoDeviceData = photo.dataUrl;
                            fotoDevicePath = null;
                            let p = document.getElementById('fotoPreview');
                            p.innerHTML = `<img src="${photo.dataUrl}" style="max-width:100%; max-height:100px; border-radius:8px;">`;
                            p.classList.add('show');
                        }
                    } catch (err) {
                        showToast('Gagal mengambil foto: ' + err.message);
                    }
                } else {
                    showToast('Plugin Camera tidak tersedia');
                }
            } else {
                let f = input.files[0]; if(!f) return; if(f.size > 2*1024*1024){ showToast('Foto maksimal 2MB'); return; }
                let r = new FileReader();
                r.onload = e => { fotoDeviceData = e.target.result; fotoDevicePath = null; let p = document.getElementById('fotoPreview'); p.innerHTML = `<img src="${fotoDeviceData}" style="max-width:100%; max-height:100px; border-radius:8px;">`; p.classList.add('show'); };
                r.readAsDataURL(f);
            }
        }

        // ========== UNTUK @capacitor-community/contacts v5/v6/v7 ==========
        async function importContact() {
            if (isCapacitor()) {
                const Contacts = getPlugin('Contacts');
                if (Contacts) {
                    try {
                        const perm = await Contacts.requestPermissions();
                        if (perm.contacts !== 'granted') {
                            showToast('Izin akses kontak ditolak');
                            return;
                        }
                        
                        // v5/v6/v7: pickContact() mengembalikan { contact: {...} }
                        const result = await Contacts.pickContact({ projection: { name: true, phones: true } });
                        console.log("Raw result:", JSON.stringify(result, null, 2));
                        
                        // ✅ CEK: result.contact (bukan result langsung)
                        if (!result || !result.contact) {
                            showToast('Tidak ada kontak dipilih');
                            return;
                        }
                        
                        const contact = result.contact;
                        
                        // ✅ Ambil nama dari contact.name.display
                        let nama = '';
                        if (contact.name) {
                            if (contact.name.display) {
                                nama = contact.name.display;
                            } else if (contact.name.given) {
                                nama = contact.name.given;
                                if (contact.name.family) nama += ' ' + contact.name.family;
                            }
                        }
                        
                        // ✅ Ambil nomor dari contact.phones (bukan phoneNumbers)
                        let phone = '';
                        if (contact.phones && contact.phones.length > 0) {
                            const mobilePhone = contact.phones.find(p => 
                                p.type && p.type.toLowerCase() === 'mobile'
                            );
                            phone = mobilePhone ? mobilePhone.number : contact.phones[0].number;
                        }
                        
                        // Bersihkan dan set value
                        phone = phone.replace(/\D/g, '');
                        if (phone.startsWith('62')) phone = '0' + phone.substring(2); else if (phone.startsWith('8')) phone = '0' + phone;
                        
                        document.getElementById('nama').value = nama.trim();
                        document.getElementById('nohp').value = phone;
                        
                        showToast(`✅ Kontak diimport: ${nama}`);
                        
                    } catch (e) {
                        console.error('Kontak error:', e);
                        showToast('❌ Gagal: ' + e.message);
                    }
                } else {
                    showToast('Plugin Contacts tidak tersedia');
                }
            } else {
                showToast('Fitur kontak hanya tersedia di aplikasi Android');
            }
        }
        // ================================================

        async function saveContact() {
            const nama = document.getElementById('nama').value.trim(), nohp = document.getElementById('nohp').value.trim().replace(/\D/g, '');
            if (!nama) { showToast('Isi nama pelanggan terlebih dahulu'); return; }
            if (!nohp) { showToast('Isi nomor HP pelanggan terlebih dahulu'); return; }
            const C = getPlugin('Contacts');
            if (!C) return saveContactViaShare();
            try {
                const perm = await C.requestPermissions();
                if (perm.contacts !== 'granted') throw new Error('Izin kontak ditolak');
                const target = normalizePhone(nohp).slice(-9);
                const res = await C.getContacts({ projection: { name: true, phones: true } });
                const dup = (res.contacts || []).find(c => (c.phones || []).some(p => normalizePhone(p.number).slice(-9) === target));
                if (dup) { showToast('Nomor sudah ada di kontak: ' + ((dup.name && dup.name.display) || nohp)); return; }
                await C.createContact({ contact: { name: { given: nama }, phones: [{ type: 'mobile', number: nohp }] } });
                showToast('✅ Kontak tersimpan di HP');
            } catch (e) {
                showToast('Simpan langsung gagal, membuka menu bagikan...');
                return saveContactViaShare();
            }
        }
        async function saveContactViaShare() {
            const nama = document.getElementById('nama').value.trim(); let nohp = document.getElementById('nohp').value.trim().replace(/\D/g, '');
            if (!nama) { showToast('Isi nama pelanggan terlebih dahulu'); return; }
            if (!nohp) { showToast('Isi nomor HP pelanggan terlebih dahulu'); return; }
            const vCard = `BEGIN:VCARD\nVERSION:3.0\nFN:${nama}\nN:${nama};;;\nTEL;TYPE=CELL:${nohp}\nEND:VCARD`;
            if (isCapacitor()) {
                const Filesystem = getPlugin('Filesystem');
                const Share = getPlugin('Share');
                if (Filesystem && Share) {
                    try {
                        const b64 = btoa(unescape(encodeURIComponent(vCard)));
                        const fn = `${nama.replace(/[^\w\-]+/g, '_')}.vcf`;
                        await Filesystem.writeFile({ path: fn, data: b64, directory: 'CACHE', recursive: true });
                        const uri = await Filesystem.getUri({ path: fn, directory: 'CACHE' });
                        await Share.share({ title: 'Simpan Kontak', text: `Kontak ${nama}`, url: uri.uri, dialogTitle: 'Simpan ke kontak' });
                        showToast('Kontak siap disimpan');
                    } catch (e) { showToast('Gagal: ' + e.message); }
                } else { showToast('Plugin Filesystem/Share tidak tersedia'); }
            } else {
                const blob = new Blob([vCard], { type: 'text/vcard' }), url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `${nama}.vcf`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                showToast('File kontak dibuat. Buka dengan aplikasi Kontak.');
            }
        }

        async function buatPreview() {
            // Cek trial limit sebelum menyimpan nota baru
            if (!canCreateNota()) {
                showActivationDialog();
                showToast('⛔ Trial habis (100 transaksi). Silakan aktivasi untuk lanjut.');
                return;
            }
            if (!validateForm()) { showToast('Harap lengkapi data wajib!'); return; }
            if (currentType === 'jual') { hitungJual(); if (!document.getElementById('nama').value.trim()) document.getElementById('nama').value = 'Pelanggan Umum'; }
            ['nama','merek','model'].forEach(id => { const e = document.getElementById(id); e.value = capWords(e.value); });
            showLoading();
            try {
                if (!(await spPreflight())) return;
                let estAwal = 0;
                const chainId = window._lanjutOriginalId || (window._spEditFrom && (historyData.find(h => h.id === window._spEditFrom) || {}).originalId);
                if ((currentType === 'selesai' || currentType === 'ambil') && chainId) {
                    const est = historyData.filter(h => (h.originalId || h.id) === chainId && h.type === 'diagnosa').sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp))[0];
                    if (est && est.totalBiaya > 0) { estAwal = est.totalBiaya; const fin = parseFloat(document.getElementById('totalBiaya').value) || 0; if (fin !== estAwal && !confirm(`Biaya akhir (Rp ${formatRupiah(fin)}) berbeda dari estimasi diagnosa (Rp ${formatRupiah(estAwal)}). Lanjutkan?`)) return; }
                }
                const itemsJual = currentType === 'jual' ? bacaItemJual() : [];
                const device = `${document.getElementById('merek').value} ${document.getElementById('model').value}`.trim();
                const now = new Date(), prevNota = (window._spEditFrom && historyData.find(h => h.id === window._spEditFrom && h.type === currentType)) || null, notaId = prevNota ? prevNota.id : newNotaId(), originalId = prevNota ? (prevNota.originalId || prevNota.id) : ((CHAIN_TYPES.includes(currentType) && window._lanjutOriginalId) || notaId);
                let timeline = [];
                if (prevNota) { timeline = (prevNota.timeline || []).slice(0, -1); } else if (CHAIN_TYPES.includes(currentType) && window._lanjutOriginalId) { const p = historyData.find(h => h.id === window._lanjutOriginalId); if (p && p.timeline) timeline = [...p.timeline]; }
                timeline.push({ status: currentType, timestamp: now.toISOString(), waktu: now.toLocaleString('id-ID'), setuju: currentType === 'diagnosa' && document.getElementById('statusDiagnosa').value === 'setuju', sub: currentType === 'diagnosa' ? document.getElementById('statusDiagnosa').value : '' });
                const totalBiaya = parseFloat(document.getElementById('totalBiaya').value)||0, dp = parseFloat(document.getElementById('dp').value)||0, sisa = totalBiaya - dp;
                let fotoStorage = null;
                if (isCapacitor() && fotoDevicePath) fotoStorage = { type: 'file', path: fotoDevicePath };
                else if (fotoDeviceData) fotoStorage = { type: 'base64', data: fotoDeviceData };
                let pwd = document.getElementById('passwordDevice').value, mt = document.getElementById('passwordDeviceText').value.trim();
                if (mt) pwd = mt;
                currentNota = { id: notaId, type: currentType, notaId, originalId, nama: escapeHtml(document.getElementById('nama').value.trim()), nohp: document.getElementById('nohp').value, device: escapeHtml(currentType === 'jual' ? 'Penjualan Aksesoris' : device), keluhan: escapeHtml(currentType === 'jual' ? itemsJual.map(it => it.qty + 'x ' + it.nama).join(', ') : document.getElementById('keluhan').value.trim()), totalBiaya, dp, sisa, kurangBayar: (currentType === 'ambil' || currentType === 'langsung') ? Math.min(Math.max(parseFloat(document.getElementById('kurangBayar').value) || 0, 0), Math.max(sisa, 0)) : 0, estimasi: escapeHtml(document.getElementById('estimasi').value), catatan: escapeHtml(document.getElementById('catatan').value), tanggal: now.toLocaleDateString('id-ID'), jam: now.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}), timestamp: now.toISOString(), kelengkapan: currentType === 'terima' ? Array.from(document.querySelectorAll('#kelengkapanSection input:checked')).map(cb => cb.value) : [], kondisi: currentType === 'jual' ? [] : getKondisi(), passwordDevice: escapeHtml(pwd), fotoDevice: fotoStorage, diagnosa: currentType === 'diagnosa' ? { hasil: escapeHtml(document.getElementById('hasilDiagnosa').value), sparepart: escapeHtml(document.getElementById('sparepart').value), status: document.getElementById('statusDiagnosa').value, hargaSparepart: parseFloat(document.getElementById('hargaSparepart').value) || 0, biayaJasa: parseFloat(document.getElementById('biayaJasa').value) || 0 } : null, selesai: currentType === 'selesai' ? { detail: escapeHtml(document.getElementById('detailPerbaikan').value), status: document.getElementById('statusSelesai').value, siapAmbil: escapeHtml(document.getElementById('siapAmbil').value), garansi: Math.max(parseInt(document.getElementById('garansiSelesai').value) || 0, 0) } : null, ambil: currentType === 'ambil' ? { status: currentStatus, alasan: document.getElementById('alasanBatal').value } : null, timeline, modal: parseFloat(document.getElementById('modal').value)||0, partsUsed: (currentType === 'selesai' || currentType === 'langsung') ? bacaPartsUsed().map(p => ({ itemId: p.itemId, name: p.name, qty: p.qty, cost: p.cost })) : [], partsPlan: currentType === 'diagnosa' ? bacaPartsUsed().map(p => ({ itemId: p.itemId, name: p.name, qty: p.qty, cost: p.cost })) : [], metodeBayar: document.getElementById('metodeBayar').value, estimasiAwal: estAwal, langsung: currentType === 'langsung' ? { detail: escapeHtml(document.getElementById('detailLangsung').value.trim()), sparepart: escapeHtml(document.getElementById('sparepartLangsung').value.trim()), garansi: Math.max(parseInt(document.getElementById('garansiLangsung').value) || 0, 0) } : null, jual: itemsJual.length ? { items: itemsJual.map(it => ({ nama: escapeHtml(it.nama), qty: it.qty, harga: it.harga, modal: it.modal, itemId: it.itemId || '' })) } : null, klaim: (klaimMode && (currentType === 'terima' || window._lanjutOriginalId || prevNota)) ? { asal: escapeHtml(document.getElementById('klaimAsal').value.trim()), info: escapeHtml(document.getElementById('klaimInfo').textContent.trim()) } : null };
                const lanjutBackup = window._lanjutOriginalId; delete window._lanjutOriginalId;
                currentNota = sanitizeNota(currentNota);
                renderPreview();
                if (!(await saveToHistory(currentNota))) { if (lanjutBackup) window._lanjutOriginalId = lanjutBackup; return; } // form tetap terbuka agar data tidak hilang
                if (historyData.some(h => h.id === currentNota.id)) { try { if (window._spEditFrom) { await spRestoreForNota(window._spEditFrom); delete window._spEditFrom; } await spConsumeForNota(currentNota); if (currentNota.type === 'ambil' && currentNota.ambil && currentNota.ambil.status === 'batal') await spReturnForChain(currentNota); } catch (e) { showToast('Nota tersimpan, tetapi stok gagal diperbarui: ' + e.message); } }
                localStorage.removeItem('nota_draft');
                document.getElementById('formCard').classList.remove('active');
                document.getElementById('previewCard').classList.add('active');
                updateWorkflowButtons();
                updateLicenseUI(); // update sisa trial setelah nota baru tersimpan
                if (currentType === 'selesai' && autoWASelesai) sendAutoWA(currentNota, 'selesai');
                else if (currentType === 'ambil' && currentNota.ambil?.status === 'diambil' && autoWAAmbil) sendAutoWA(currentNota, 'ambil');
                if (autoPrint) setTimeout(() => printBluetooth().catch(e => console.warn('Auto print gagal:', e)), 500);
            } catch (e) { console.error('buatPreview gagal', e); showToast('❌ Kesalahan menyimpan nota: ' + ((e && e.message) || e)); } finally { hideLoading(); }
        }

        function renderPreview() {
            let badgeClass, badgeText, paperClass;
            switch(currentType){ case 'terima': badgeClass='badge-terima'; badgeText='📥 NOTA PENERIMAAN'; paperClass='terima'; break; case 'diagnosa': badgeClass='badge-diagnosa'; badgeText='🔍 HASIL DIAGNOSA'; paperClass='diagnosa'; break; case 'selesai': badgeClass='badge-selesai'; badgeText='✅ SELESAI'; paperClass='selesai'; break; case 'jual': badgeClass='badge-ambil'; badgeText='🛍️ NOTA PENJUALAN'; paperClass='ambil'; break; case 'langsung': badgeClass='badge-ambil'; badgeText='⚡ SERVIS LANGSUNG'; paperClass='ambil'; break; case 'ambil': if(currentNota.ambil?.status==='batal'){ badgeClass='badge-batal'; badgeText='❌ DIBATALKAN'; paperClass='batal'; } else { badgeClass='badge-ambil'; badgeText='📤 DIAMBIL'; paperClass='ambil'; } break; }
            let html = `<div class="nota-header">`;
            if(isSafeImg(logoData)) html+=`<img src="${logoData}" class="nota-logo">`;
            html+=`<h2>${escapeHtml(tokoSettings.nama||'Nota Service HP')}</h2>`;
            if(tokoSettings.slogan) html+=`<div class="nota-slogan">✨ ${escapeHtml(tokoSettings.slogan)}</div>`;
            if(tokoSettings.alamat) html+=`<div class="nota-alamat">📍 ${escapeHtml(tokoSettings.alamat)}</div>`;
            if(tokoSettings.telepon) html+=`<div class="nota-telp">📞 ${escapeHtml(tokoSettings.telepon)}</div>`;
            html+=`<span class="nota-type-badge ${badgeClass}">${badgeText}</span>`;
            html+=`<div style="font-size:12px; color:#666;">${currentNota.tanggal} • ${currentNota.jam}</div>`;
            html+=`<div class="nota-id">${currentNota.notaId}</div></div>`;
            html+=`<div class="nota-section"><div class="nota-section-title">👤 Pelanggan</div>`;
            html+=`<div class="nota-row"><span class="nota-label">Nama</span><span class="nota-value">${currentNota.nama}</span></div>`;
            if(currentNota.nohp) html+=`<div class="nota-row"><span class="nota-label">No. HP</span><span class="nota-value">${currentNota.nohp}</span></div>`;
            if(currentType!=='jual') html+=`<div class="nota-row"><span class="nota-label">Device</span><span class="nota-value">${currentNota.device}</span></div>`;
            if(currentNota.klaim) html+=`<div class="nota-row"><span class="nota-label">🛡️ Klaim Garansi</span><span class="nota-value">${currentNota.klaim.asal||'-'}</span></div>`; if(currentNota.klaim && currentNota.klaim.info) html+=`<div style="font-size:12px; color:#666;">${currentNota.klaim.info}</div>`;
            // Password/pola perangkat sengaja tidak ditampilkan pada nota pelanggan.
            if(currentType==='jual' && currentNota.jual){ html+=`</div><div class="nota-section"><div class="nota-section-title">🛍️ Barang</div>`; currentNota.jual.items.forEach(it=>{ html+=`<div class="nota-row"><span class="nota-label">${it.qty}x ${it.nama}<br><small>@ Rp ${formatRupiah(it.harga)}</small></span><span class="nota-value">Rp ${formatRupiah(it.qty*it.harga)}</span></div>`; }); if(currentNota.metodeBayar) html+=`<div style="margin-top:6px;"><strong>Pembayaran:</strong> ${escapeHtml(currentNota.metodeBayar)}</div>`; } else { html+=`</div><div class="nota-section"><div class="nota-section-title">📋 Detail Service</div>`;
            html+=`<div><strong>Keluhan:</strong> ${currentNota.keluhan}</div>`; }
            if(currentNota.kelengkapan?.length) html+=`<div style="margin-top:5px;"><strong>Kelengkapan:</strong> ${currentNota.kelengkapan.join(', ')}</div>`;
            if(currentNota.kondisi?.length) html+=`<div style="margin-top:5px;"><strong>Kondisi Fisik:</strong> ${currentNota.kondisi.join(', ')}</div>`;
            if(currentNota.fotoDevice) { let imgSrc = currentNota.fotoDevice.type === 'file' && isCapacitor() ? currentNota.fotoDevice.path : currentNota.fotoDevice.type === 'base64' ? currentNota.fotoDevice.data : ''; if(imgSrc && (isSafeImg(imgSrc) || currentNota.fotoDevice.type === 'file')) html+=`<div style="margin-top:8px;"><img src="${imgSrc}" style="max-width:100%; max-height:100px; border-radius:8px;"></div>`; }
            if(currentNota.catatan) html+=`<div style="margin-top:5px;"><strong>📝 Catatan:</strong> ${currentNota.catatan}</div>`;
            if((currentType==='terima' || currentType==='diagnosa') && currentNota.estimasi) html+=`<div style="margin-top:5px;"><strong>⏱️ Estimasi waktu:</strong> ${currentNota.estimasi}</div>`;
            if(currentType==='diagnosa' && currentNota.diagnosa){ html+=`<div style="margin-top:10px;"><strong>🔍 Hasil Diagnosa:</strong> ${currentNota.diagnosa.hasil||'-'}</div>`; if(currentNota.diagnosa.sparepart) html+=`<div><strong>Sparepart:</strong> ${currentNota.diagnosa.sparepart}</div>`;
                { const dg = currentNota.diagnosa; if (dg.hargaSparepart > 0 || dg.biayaJasa > 0) html += `<div style="margin-top:4px;">${dg.hargaSparepart > 0 ? `Harga sparepart: Rp ${formatRupiah(dg.hargaSparepart)}<br>` : ''}${dg.biayaJasa > 0 ? `Biaya jasa: Rp ${formatRupiah(dg.biayaJasa)}` : ''}</div>`; } let stat={bisa:'✅ Bisa diperbaiki',tidak:'❌ Tidak bisa diperbaiki',pending:'⏳ Menunggu konfirmasi',setuju:'🤝 Disetujui pelanggan',sparepart:'📦 Menunggu sparepart',proses:'🔧 Sedang dikerjakan'}; html+=`<div><strong>Status:</strong> ${stat[currentNota.diagnosa.status]||currentNota.diagnosa.status}</div>`; }
            if(currentType==='selesai' && currentNota.selesai){ html+=`<div style="margin-top:10px;"><strong>✅ Detail Perbaikan:</strong> ${currentNota.selesai.detail||'-'}</div>`; let stat={normal:'✅ Berfungsi normal',partial:'⚠️ Berfungsi sebagian',tidak:'❌ Tidak bisa'}; html+=`<div><strong>Status:</strong> ${stat[currentNota.selesai.status]||currentNota.selesai.status}</div>`; if(currentNota.selesai.siapAmbil) html+=`<div><strong>Siap diambil:</strong> ${currentNota.selesai.siapAmbil}</div>`; if(currentNota.selesai.garansi>0) html+=`<div><strong>Garansi:</strong> ${currentNota.selesai.garansi} hari setelah unit diambil</div>`; if(currentNota.partsUsed && currentNota.partsUsed.length) html+=`<div><strong>🔩 Sparepart:</strong> ${currentNota.partsUsed.map(p=>p.qty+'x '+p.name).join(', ')}</div>`; }
            if(currentType==='ambil' && currentNota.ambil){ if(currentNota.ambil.status==='diambil') html+=`<div style="margin-top:10px; background:#e8f5e9; padding:8px; border-radius:8px;"><strong>✅ Status:</strong> Sudah diambil oleh pelanggan</div>`; else html+=`<div style="margin-top:10px; background:#ffebee; padding:8px; border-radius:8px;"><strong>❌ Status:</strong> Dibatalkan<br>Alasan: ${escapeHtml(currentNota.ambil.alasan||'-')}</div>`; }
            if(currentType==='ambil' && currentNota.ambil && currentNota.ambil.status==='diambil'){ const gh = garansiHari(historyData.filter(h => (h.originalId||h.id)===currentNota.originalId)); if(gh>0){ const ge = new Date(new Date(currentNota.timestamp).getTime()+gh*86400000).toLocaleDateString('id-ID'); html+=`<div style="margin-top:6px;"><strong>🛡️ Garansi:</strong> ${gh} hari (s/d ${ge})</div>`; } }
            if(currentType==='langsung' && currentNota.langsung){ const L=currentNota.langsung; html+=`<div style="margin-top:10px;"><strong>🔧 Detail Perbaikan:</strong> ${L.detail||'-'}</div>`; if(L.sparepart) html+=`<div><strong>Sparepart:</strong> ${L.sparepart}</div>`; if(L.garansi>0){ const gd=new Date(new Date(currentNota.timestamp).getTime()+L.garansi*86400000).toLocaleDateString('id-ID'); html+=`<div><strong>Garansi:</strong> ${L.garansi} hari (s/d ${gd})</div>`; } if(currentNota.metodeBayar) html+=`<div><strong>Pembayaran:</strong> ${escapeHtml(currentNota.metodeBayar)}</div>`; html+=`<div style="margin-top:10px; background:#e8f5e9; padding:8px; border-radius:8px;"><strong>✅ Status:</strong> Selesai &amp; langsung diambil pelanggan</div>`; }
            html+=`</div>`;
            if(currentNota.totalBiaya>0){
                const n=currentNota, rpf=v=>'Rp '+formatRupiah(v), row=(l,v)=>`<div class="nota-row"><span class="nota-label">${l}</span><span class="nota-value">${v}</span></div>`;
                const fin = n.type==='langsung' || n.type==='jual' || (n.type==='ambil' && n.ambil && n.ambil.status==='diambil');
                html+=`<div class="nota-total">`+row(biayaLabel(currentType), rpf(n.totalBiaya));
                if(n.dp>0) html+=row('DP / Panjar', rpf(n.dp));
                if(fin){
                    if(n.dp>0 || n.kurangBayar>0) html+=row('Dibayar saat ambil', rpf(Math.max(n.sisa-n.kurangBayar,0)));
                    html+= n.kurangBayar>0 ? `<div class="nota-lunas belum">⚠️ BELUM LUNAS<small>Kurang bayar ${rpf(n.kurangBayar)}</small></div>` : `<div class="nota-lunas lunas">✅ LUNAS</div>`;
                } else if(n.dp>0) html+=row((n.type==='terima'||n.type==='diagnosa') ? 'Estimasi Sisa' : 'Sisa Pembayaran', rpf(n.sisa));
                html+=`</div>`;
            }
            // QRIS di nota konsumen (setelah total)
            try {
                const showAlways = localStorage.getItem('toko_qris_always') === 'true';
                const hasBill = (currentNota.totalBiaya > 0) || (currentNota.sisa > 0) || (currentNota.kurangBayar > 0);
                if (isSafeImg(qrisData) && (showAlways || hasBill)) {
                    const ql = (localStorage.getItem('toko_qris_label') || '').trim();
                    html += `<div class="nota-qris"><div class="qris-title">Bayar via QRIS</div><img src="${qrisData}" alt="QRIS"><div class="qris-label">${escapeHtml(ql || 'Scan QRIS untuk membayar')}</div></div>`;
                }
            } catch (_) {}
            if(currentNota.estimasiAwal>0 && currentNota.estimasiAwal!==currentNota.totalBiaya) html+=`<div style="font-size:12px; color:#666; margin-top:6px;">Estimasi awal diagnosa: Rp ${formatRupiah(currentNota.estimasiAwal)}</div>`;
            if(currentType==='diagnosa') html+=`<div style="font-size:12px; color:#666; margin-top:6px;">⚠️ Estimasi dapat berubah. Kami akan konfirmasi bila ada selisih biaya.</div>`;
            if(currentNota.timeline && currentNota.timeline.length>1){ html+=`<div class="timeline"><div style="font-size:12px; font-weight:bold; color:var(--primary); margin-bottom:8px;">📅 Timeline Service</div>`; currentNota.timeline.forEach(item=>{ let name={terima:'📥 Diterima',diagnosa:'🔍 Diagnosa',selesai:'✅ Selesai',ambil:'📤 Diambil/Dibatalkan',langsung:'⚡ Servis langsung'}[item.status]||item.status; const subMap = {setuju:'disetujui pelanggan', sparepart:'menunggu sparepart', proses:'sedang dikerjakan'}; if (item.status === 'diagnosa' && subMap[item.sub]) name += ' (' + subMap[item.sub] + ')'; else if(item.setuju) name += ' (disetujui pelanggan)'; html+=`<div style="font-size:11px; color:#666; margin-bottom:6px; display:flex; align-items:baseline; gap:8px;"><span style="flex:none; width:8px; height:8px; border-radius:50%; background:var(--primary);"></span><span style="font-family:monospace; font-size:10px; color:#999; white-space:nowrap;">${new Date(item.timestamp).toLocaleString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span> <strong>${name}</strong></div>`; }); html+=`</div>`; }
            let footer = (footers[footerKey()]?.enabled && footers[footerKey()]?.text) ? footers[footerKey()].text : '';
            if(footer) html+=`<div class="nota-footer">${escapeHtml(footer).replace(/\n/g,'<br>')}</div>`;
            if((currentType==='terima' || currentType==='ambil' || currentType==='langsung') && skText.trim()) html+=`<div class="syarat-section"><strong>📜 SYARAT &amp; KETENTUAN</strong><br>${escapeHtml(skText).replace(/\n/g,'<br>')}</div>`;
            html+=`<div style="text-align:center; margin-top:20px; font-size:11px; color:#999;">Terima kasih atas kepercayaan Anda<br>Simpan nota ini sebagai bukti</div>`;
            document.getElementById('notaContent').innerHTML = html;
            document.getElementById('notaContent').className = `nota-paper ${paperClass}`;
        }

        function isNotaLocked() { return currentNota && (currentNota.type === 'ambil' || currentNota.type === 'langsung' || currentNota.type === 'jual'); }
        function updateWorkflowButtons() {
            let c = document.getElementById('workflowButtons');
            if(!currentNota){ c.innerHTML=''; return; }
            if(isNotaLocked()){ c.innerHTML='<div style="text-align:center; padding:10px; background:#ffebee; border-radius:12px; color:#c62828;">🔒 Nota sudah selesai (diambil/dibatalkan). Tidak dapat diedit lagi.</div>'; return; }
            let btns='';
            if(currentType==='terima') btns='<button class="btn-workflow diagnosa" onclick="app.lanjutKe(\'diagnosa\')">🔍 Lanjut ke Diagnosa</button>';
            else if(currentType==='diagnosa') btns='<button class="btn-workflow selesai" onclick="app.lanjutKe(\'selesai\')">✅ Lanjut ke Selesai</button>' + '<button class="btn-workflow diagnosa" style="margin-top:8px;" onclick="app.lanjutKe(\'diagnosa\')">🔄 Update Status / Sparepart</button>';
            else if(currentType==='selesai') btns='<button class="btn-workflow ambil" onclick="app.lanjutKe(\'ambil\')">📤 Lanjut ke Ambil</button>';
            c.innerHTML = btns ? `<div style="margin-bottom:10px; font-size:13px;">📌 Lanjutkan ke tahap berikutnya:</div>${btns}` : '';
        }

        async function lanjutKe(tipeBaru) {
            if(!currentNota || isNotaLocked()){ showToast('Nota terkunci, tidak dapat dilanjutkan'); return; }
            document.getElementById('nama').value = currentNota.nama;
            document.getElementById('nohp').value = currentNota.nohp;
            let parts = currentNota.device.split(' ');
            document.getElementById('merek').value = parts[0]||'';
            document.getElementById('model').value = parts.slice(1).join(' ')||'';
            document.getElementById('keluhan').value = currentNota.keluhan;
            document.getElementById('totalBiaya').value = currentNota.totalBiaya||0;
            document.getElementById('dp').value = currentNota.dp||0;
            document.getElementById('modal').value = currentNota.modal||0;
            document.getElementById('kurangBayar').value = currentNota.kurangBayar||0;
            if (currentNota.metodeBayar) document.getElementById('metodeBayar').value = currentNota.metodeBayar;
            hitungSisa();
            document.getElementById('estimasi').value = currentNota.estimasi||'';
            klaimMode = !!currentNota.klaim; if (currentNota.klaim) { document.getElementById('klaimAsal').value = unesc(currentNota.klaim.asal || ''); document.getElementById('klaimInfo').textContent = unesc(currentNota.klaim.info || ''); }
            document.getElementById('catatan').value = currentNota.catatan||'';
            let pwd = currentNota.passwordDevice || '';
            document.getElementById('passwordDevice').value = pwd;
            document.getElementById('passwordDeviceText').value = pwd;
            if (/^(\d+-)*\d+$/.test(pwd)) { patternPath = pwd.split('-').map(Number); drawPatternCanvas(); updatePatternOutput(); } else { patternPath = []; drawPatternCanvas(); updatePatternOutput(); }
            if(currentNota.kondisi){ document.querySelectorAll('.kondisi-checkbox').forEach(cb => cb.classList.remove('active')); currentNota.kondisi.forEach(k => { let el = Array.from(document.querySelectorAll('.kondisi-checkbox')).find(c => c.dataset.value === k); if(el) el.classList.add('active'); }); let lainnya = currentNota.kondisi.filter(k => !['Penyok','Lecet','Retak','Basah','Lainnya'].includes(k)).join(', '); document.getElementById('kondisiLainnya').value = lainnya; }
            if(currentNota.fotoDevice) { if (currentNota.fotoDevice.type === 'base64') { fotoDeviceData = currentNota.fotoDevice.data; fotoDevicePath = null; let p = document.getElementById('fotoPreview'); p.innerHTML = `<img src="${fotoDeviceData}" style="max-width:100%; max-height:100px;">`; p.classList.add('show'); } else if (currentNota.fotoDevice.type === 'file') { fotoDevicePath = currentNota.fotoDevice.path; fotoDeviceData = null; let p = document.getElementById('fotoPreview'); p.innerHTML = `<img src="${fotoDevicePath}" style="max-width:100%; max-height:100px;">`; p.classList.add('show'); } }
            if(currentNota.kelengkapan) document.querySelectorAll('#kelengkapanSection input[type="checkbox"]').forEach(cb => cb.checked = currentNota.kelengkapan.includes(cb.value));
            if(tipeBaru==='diagnosa'){ const dd = currentNota.type === 'diagnosa' ? currentNota.diagnosa : null; document.getElementById('hasilDiagnosa').value = dd ? unesc(dd.hasil) : ''; document.getElementById('sparepart').value = dd ? unesc(dd.sparepart) : ''; document.getElementById('statusDiagnosa').value = dd ? dd.status : 'bisa'; document.getElementById('hargaSparepart').value = dd && dd.hargaSparepart ? dd.hargaSparepart : ''; document.getElementById('biayaJasa').value = dd && dd.biayaJasa ? dd.biayaJasa : ''; }
            else if(tipeBaru==='selesai'){ document.getElementById('detailPerbaikan').value = ''; document.getElementById('statusSelesai').value = 'normal'; document.getElementById('siapAmbil').value = ''; document.getElementById('garansiSelesai').value = 0; }
            else if(tipeBaru==='ambil'){ selectAmbilStatus('diambil'); document.getElementById('alasanBatal').value = 'Tidak bisa diperbaiki'; }
            selectType(tipeBaru);
            spPrefillPlan(currentNota, tipeBaru); delete window._spEditFrom;
            window._lanjutOriginalId = currentNota.originalId || currentNota.id;
            document.getElementById('previewCard').classList.remove('active');
            document.getElementById('formCard').classList.add('active');
            showToast(`Silakan lengkapi data untuk tahap ${tipeBaru.toUpperCase()}`);
        }

        async function captureNotaAsImage(targetWidth = 400, quality = 0.8, scale = 2.5) {
            const el = document.getElementById('notaContent'), ow = el.style.width, oc = el.className;
            el.style.width = targetWidth + 'px'; el.classList.add('capture-wide');
            await new Promise(r => setTimeout(r, 50));
            const canvas = await html2canvas(el, { scale, backgroundColor: '#ffffff', windowWidth: el.scrollWidth, logging: false });
            el.style.width = ow; el.className = oc;
            return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        }

        async function kirimWA(mode){
            if(!currentNota) return;
            let no = normalizePhone(currentNota.nohp);
            if(!no){ showToast('Nomor HP pelanggan kosong, tidak bisa kirim WhatsApp'); return; }
            if(mode==='teks'){
                let template = localStorage.getItem('wa_template') || `*{toko}*\n━━━━━━━━━━━━━━━\n{type_badge}\n━━━━━━━━━━━━━━━\n\n🆔 No: *{nota_id}*\n📅 {tanggal} | ⏰ {jam}\n\n👤 *Pelanggan:* {nama}\n📱 *Device:* {device}\n\n📋 *Keluhan:*\n{keluhan}\n\n{kelengkapan_line}\n💰 *Estimasi Biaya:* Rp {biaya}\n⏳ *Estimasi Waktu:* {estimasi}\n\n📝 *Catatan:* {catatan}\n\n━━━━━━━━━━━━\n{footer}`;
                let badge = {terima:'📥 *NOTA PENERIMAAN*',diagnosa:'🔍 *HASIL DIAGNOSA*',selesai:'✅ *NOTA SELESAI*',jual:'🛍️ *NOTA PENJUALAN*',langsung:'⚡ *NOTA SERVIS LANGSUNG*',ambil:currentNota.ambil?.status==='batal'?'❌ *DIBATALKAN*':'📤 *NOTA AMBIL*'}[currentType]||'📋 *NOTA SERVICE*';
                let kelengkapanLine = currentNota.kelengkapan?.length ? `📦 *Kelengkapan:* ${currentNota.kelengkapan.join(', ')}` : '📦 *Kelengkapan:* -';
                let msg = template.replace(/{toko}/g, tokoSettings.nama||'Service HP').replace(/{type_badge}/g, badge).replace(/{nota_id}/g, currentNota.notaId).replace(/{tanggal}/g, currentNota.tanggal).replace(/{jam}/g, currentNota.jam).replace(/{nama}/g, () => unesc(currentNota.nama)).replace(/{device}/g, () => unesc(currentNota.device)).replace(/{keluhan}/g, () => unesc(currentNota.keluhan)).replace(/{kelengkapan_line}/g, kelengkapanLine).replace(/{biaya}/g, formatRupiah(currentNota.totalBiaya)).replace(/{estimasi}/g, currentNota.estimasi||'-').replace(/{catatan}/g, () => unesc(currentNota.catatan)||'-').replace(/{footer}/g, footers[footerKey()]?.enabled?footers[footerKey()].text:'');
                msg = msg.replace('*Estimasi Biaya:*', `*${biayaLabel(currentType)}:*`);
                window.open(`https://wa.me/${no}?text=${encodeURIComponent(msg)}`,'_blank');
            } else if(mode==='gambar'){
                showLoading();
                try{
                    const blob = await captureNotaAsImage(400, 0.8, 2.5);
                    const file = new File([blob], `Nota_${currentNota.notaId}.jpg`, { type: 'image/jpeg' });
                    if (isCapacitor()) {
                        const fname = `Nota_${currentNota.notaId}.jpg`, b64 = await blobToB64(blob);
                        let sentDirect = false;
                        if (no) {
                            try {
                                const w = await getPlugin('Filesystem').writeFile({ path: fname, data: b64, directory: 'CACHE' });
                                await getPlugin('WhatsAppShare').sendImage({ uri: w.uri, phone: no, pkg: localStorage.getItem('wa_app') || 'auto' });
                                sentDirect = true;
                                showToast('Chat WhatsApp pelanggan terbuka, tekan kirim');
                            } catch (waErr) {
                                console.warn('WA langsung gagal, pakai menu bagikan:', waErr);
                            }
                        }
                        if (!sentDirect) { await shareFile(fname, b64, 'image/jpeg', `Nota ${currentNota.notaId}`); showToast('Berhasil dibagikan'); }
                    } else if (navigator.share && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: `Nota ${currentNota.notaId}` }); }
                    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `Nota_${currentNota.notaId}.jpg`; a.click(); URL.revokeObjectURL(a.href); showToast('Gambar disimpan, silakan kirim manual'); }
                } catch(e){ showToast('Gagal membuat gambar: ' + e.message); }
                finally { hideLoading(); }
            }
        }

        class NotaPrinter {
            constructor() { this.paperSize = localStorage.getItem('printer_size')||'58'; }
            get wide() { return this.paperSize === '80' || this.paperSize === '75'; }
            get chars() { return this.wide ? 48 : 32; }
            // Teks bertag -> byte ESC/POS (lihat src/escpos.js)
            encodeData(data) { return tagsToEscPos(this.buildText(data), { width: this.chars, feed: 4 }); }
            buildText(d) {
                const n = (this.paperSize === '80' || this.paperSize === '75') ? 48 : 32;
                const clean = v => unesc(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[<>\[\]]/g, ' ').replace(/[^\x20-\x7E\n]/g, '').trim();
                const sep = '-'.repeat(n), rp = x => 'Rp ' + Number(x || 0).toLocaleString('id-ID');
                const L = [];
                L.push(`[C]<font size='big'><b>${clean(d.toko || 'Service HP')}</b></font>`);
                if (d.slogan) L.push(`[C]${clean(d.slogan)}`);
                if (d.telepon) L.push(`[C]Telp: ${clean(d.telepon)}`);
                L.push(`[C]${'='.repeat(n)}`);
                L.push(`[L]No      : ${clean(d.id)}`, `[L]Tanggal : ${clean(d.tanggal)}`, `[L]Nama    : ${clean(d.nama)}`, `[L]HP      : ${clean(d.nohp)}`);
                if (!d.items) L.push(`[L]Device : ${clean(d.device)}`);
                if (d.klaim) L.push('[L]<b>KLAIM GARANSI</b>', `[L]${clean(d.klaim)}`);
                if (d.items) { L.push(`[C]${sep}`); d.items.forEach(it => { L.push(`[L]${it.qty}x ${clean(it.nama)}`, `[L]  @${rp(it.harga)} [R]${rp(it.qty * it.harga)}`); }); if (d.metode) L.push(`[L]Bayar : ${clean(d.metode)}`); L.push(`[C]${sep}`); } else { L.push(`[C]${sep}`, '[L]<b>Keluhan:</b>', `[L]${clean(d.keluhan)}`, `[C]${sep}`); }
                if (d.detail) { L.push(`[L]<b>${d.detailLabel || 'Detail'}:</b>`, `[L]${clean(d.detail)}`); if (d.sparepart) L.push(`[L]Sparepart: ${clean(d.sparepart)}`); if (d.garansi) L.push(`[L]Garansi  : ${clean(d.garansi)}`); if (d.metode) L.push(`[L]Bayar    : ${clean(d.metode)}`); L.push(`[C]${sep}`); }
                if (!d.detail && d.garansi) L.push(`[L]Garansi : ${clean(d.garansi)}`, `[C]${sep}`);
                if (d.estimasi) L.push(`[L]Estimasi waktu: ${clean(d.estimasi)}`);
                if (d.biaya > 0) { (d.rincian || []).forEach(r => L.push(`[L]${r[0]} [R]${rp(r[1])}`)); L.push(`[L]${d.labelBiaya || 'Total'} [R]${rp(d.biaya)}`); if (d.dp > 0) L.push(`[L]DP      [R]${rp(d.dp)}`);
                    if (d.final) {
                        if (d.dp > 0 || d.kurang > 0) L.push(`[L]Dibayar [R]${rp(Math.max(d.sisa - d.kurang, 0))}`);
                        if (d.kurang > 0) L.push(`[L]<b>Kurang bayar</b> [R]<b>${rp(d.kurang)}</b>`, '[C]<b>** BELUM LUNAS **</b>'); else L.push('[C]<b>** LUNAS **</b>');
                    } else if (d.dp > 0) L.push(`[L]<b>${d.labelBiaya === 'Estimasi Biaya' ? 'Est. Sisa' : 'Sisa'}</b> [R]<b>${rp(d.sisa)}</b>`);
                    L.push(`[C]${sep}`); }
                if (d.noteEstimasi) L.push(`[C]${clean(d.noteEstimasi)}`);
                if (d.footer) L.push(`[C]${clean(d.footer)}`);
                if (d.qrisHint) L.push(`[C]${clean(d.qrisHint)}`);
                L.push('[C]Terima Kasih', '[C]Simpan nota ini sebagai bukti');
                return L.join('\n');
            }
            // Minta izin Bluetooth (Perangkat sekitar) sebelum list/cetak. Android 12+.
            async ensureBluetoothPermission() {
                const EP = getPlugin('EscPosPrinter');
                if (!EP || typeof EP.requestPermissions !== 'function') return true;
                try {
                    let status = await EP.checkPermissions();
                    if (status && status.bluetooth === 'granted') return true;
                    status = await EP.requestPermissions();
                    if (status && status.bluetooth === 'granted') return true;
                } catch (e) {
                    console.warn('requestPermissions Bluetooth:', e);
                }
                // Izin ditolak (mungkin "jangan tanya lagi") — tawarkan buka Pengaturan
                const buka = confirm(
                    "Izin Bluetooth / Perangkat sekitar belum diizinkan.\n\n" +
                    "Buka Pengaturan aplikasi sekarang untuk mengaktifkannya?\n\n" +
                    "Pengaturan → Aplikasi → Nota Service HP → Izin → Perangkat sekitar = Izinkan"
                );
                if (buka && typeof EP.openAppSettings === 'function') {
                    try { await EP.openAppSettings(); } catch (_) {}
                }
                throw new Error("Izin Bluetooth ditolak. Aktifkan 'Perangkat sekitar' di Pengaturan aplikasi, lalu coba lagi.");
            }
            // Tentukan tujuan cetak dari ID tersimpan: IP (LAN/WiFi) atau MAC (Bluetooth).
            async resolveTarget() {
                const lan = parseLanAddress(lastPrinterId);
                if (lan) return { type: 'tcp', address: lan.host, port: lan.port };
                await this.ensureBluetoothPermission();
                if (lastPrinterId) return { type: 'bluetooth', address: lastPrinterId };
                // Belum ada printer tersimpan: pakai printer ter-pairing (tanya bila lebih dari satu).
                const list = await listBluetoothPrinters();
                if (!list.length) throw new Error('Tidak ada printer Bluetooth ter-pairing. Pairing dulu di Pengaturan Bluetooth HP.');
                let pick = list[0];
                if (list.length > 1) { const k = parseInt(prompt('Pilih printer:\n' + list.map((x, i) => `${i + 1}. ${x.name}`).join('\n'), '1'), 10); if (!(k >= 1 && k <= list.length)) throw new Error('Dibatalkan'); pick = list[k - 1]; }
                setPrinterId(pick.address);
                return { type: 'bluetooth', address: pick.address };
            }
            async printBytes(bytes) {
                const EP = getPlugin('EscPosPrinter');
                if (EP) {
                    const target = await this.resolveTarget();
                    if (target.type === 'bluetooth') await this.ensureBluetoothPermission();
                    await EP.print({ ...target, data: bytesToBase64(bytes) });
                    showToast('✅ Nota terkirim ke printer'); return;
                }
                // Hanya untuk uji di browser (Chrome): Web Bluetooth ke printer BLE.
                if (navigator.bluetooth) {
                    let device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455'] });
                    let server = await device.gatt.connect(), service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb'), chars = await service.getCharacteristics();
                    let char = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
                    if (!char) throw new Error('Karakteristik tulis printer tidak ditemukan'); for (let o = 0; o < bytes.length; o += 100) { const part = bytes.slice(o, o + 100); if (char.properties.writeWithoutResponse && char.writeValueWithoutResponse) await char.writeValueWithoutResponse(part); else await char.writeValue(part); }
                    showToast('✅ Nota terkirim ke printer'); return;
                }
                throw new Error('Tidak ada metode cetak yang tersedia');
            }
            async print(data) { return this.printBytes(this.encodeData(data)); }
        }
        const printer = new NotaPrinter();
        async function printBluetooth() { 
            if (!currentNota) { showToast('Buat nota dulu'); return; }
            showLoading();
            try { await printer.print({ ...thermalExtra(), toko: tokoSettings.nama||'Service HP', slogan: tokoSettings.slogan || '', telepon: tokoSettings.telepon || '', id: currentNota.notaId, tanggal: currentNota.tanggal+' '+currentNota.jam, nama: unesc(currentNota.nama), nohp: currentNota.nohp || '-', device: unesc(currentNota.device), keluhan: unesc(currentNota.keluhan), biaya: currentNota.totalBiaya, dp: currentNota.dp, sisa: currentNota.sisa, footer: footers[footerKey()]?.enabled ? footers[footerKey()].text : '' }); }
            catch (e) {
                const msg = (e && e.message) || String(e);
                showToast('❌ Gagal cetak thermal: ' + msg);
                if (!/izin|permission|bluetooth|perangkat sekitar/i.test(msg)) {
                    try { generatePDF(); } catch (_) {}
                }
            }
            finally { hideLoading(); }
        }
        function setPrinterId(id) { localStorage.setItem('last_printer_id', id); lastPrinterId = id; const inp = document.getElementById('printerDeviceId'); if (inp) inp.value = id; }
        async function listBluetoothPrinters() {
            const EP = getPlugin('EscPosPrinter');
            if (!EP) throw new Error('Pilih printer hanya tersedia di aplikasi Android');
            await printer.ensureBluetoothPermission();
            const r = await EP.listPrinters();
            return (r && r.printers) || [];
        }
        // Tampilkan printer ter-pairing sebagai tombol; ketuk untuk memilih.
        async function pickPrinter() {
            const box = document.getElementById('printerList'); if (!box) return;
            box.textContent = 'Mencari printer ter-pairing...';
            try {
                const list = await listBluetoothPrinters();
                box.textContent = '';
                if (!list.length) { box.textContent = 'Belum ada perangkat Bluetooth ter-pairing. Pairing printer dulu di Pengaturan Bluetooth HP.'; return; }
                list.forEach(p => {
                    const b = document.createElement('button'); b.className = 'btn-secondary'; b.style.marginTop = '5px';
                    b.textContent = `🖨️ ${p.name} (${p.address})`;
                    b.addEventListener('click', () => { setPrinterId(p.address); box.textContent = `✅ Dipilih: ${p.name}`; showToast('Printer dipilih: ' + p.name); });
                    box.appendChild(b);
                });
            } catch (e) { box.textContent = ''; showToast('❌ ' + e.message); }
        }
        async function testPrint() {
            showLoading();
            try {
                const t = ['[C]<font size=\'big\'><b>TES PRINTER</b></font>', `[C]Kertas ${printer.paperSize} mm`, `[C]${'='.repeat(printer.chars)}`, '[L]Rata kiri', '[C]Rata tengah', '[R]Rata kanan', '[L]Kiri [R]Kanan', '[L]<b>Teks tebal</b>', `[C]${'-'.repeat(printer.chars)}`, '[C]Jika teks ini rapi, printer siap dipakai'].join('\n');
                await printer.printBytes(tagsToEscPos(t, { width: printer.chars, feed: 4 }));
            } catch (e) { showToast('❌ Tes cetak gagal: ' + e.message); }
            finally { hideLoading(); }
        }
        function savePrinterId() { let id = document.getElementById('printerDeviceId').value.trim(); if (id) { localStorage.setItem('last_printer_id', id); lastPrinterId = id; showToast('ID printer disimpan'); } else showToast('ID tidak boleh kosong'); }
        function clearPrinterId() { localStorage.removeItem('last_printer_id'); lastPrinterId = ''; document.getElementById('printerDeviceId').value = ''; showToast('ID printer dihapus'); }

        async function generatePDF(){
            showLoading();
            try{
                const blob = await captureNotaAsImage(500, 0.9, 2.5), imgData = URL.createObjectURL(blob);
                let img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = imgData; });
                let { jsPDF } = window.jspdf, doc = new jsPDF('p', 'mm', 'a4');
                let imgWidth = 190, imgHeight = (img.height * imgWidth) / img.width, pageHeight = doc.internal.pageSize.getHeight(), y = 0;
                while (y < imgHeight) { doc.addImage(imgData, 'JPEG', 10, y === 0 ? 10 : -y, imgWidth, imgHeight); y += pageHeight - 20; if (y < imgHeight) doc.addPage(); }
                if (isCapacitor()) { await shareFile(`Nota_${currentNota.notaId}.pdf`, doc.output('datauristring').split(',')[1], 'application/pdf', `Nota ${currentNota.notaId}`); } else { doc.save(`Nota_${currentNota.notaId}.pdf`); } URL.revokeObjectURL(imgData); showToast('✅ PDF siap');
            } catch(e){ showToast('Gagal PDF: ' + e.message); }
            hideLoading();
        }

        function tagsToPlain(text, width) {
            const wrap = t => { const out = []; let cur = ''; t.split(' ').forEach(w => { if ((cur + ' ' + w).trim().length > width) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }); if (cur) out.push(cur); return out.length ? out : ['']; };
            return text.split('\n').flatMap(raw => {
                const line = raw.replace(/<[^>]+>/g, ''); let m;
                if ((m = line.match(/^\[L\](.*?)\s*\[R\](.*)$/))) return [m[1] + ' '.repeat(Math.max(1, width - m[1].length - m[2].length)) + m[2]];
                if ((m = line.match(/^\[C\](.*)$/))) return wrap(m[1]).map(t => ' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t);
                if ((m = line.match(/^\[L\](.*)$/))) return wrap(m[1]);
                return [line];
            }).join('\n');
        }
        async function printFromPreview() { closeThermalPreview(); await printBluetooth(); }
        function previewThermal() {
            if (!currentNota) { showToast('Buat nota terlebih dahulu'); return; }
            const data = { ...thermalExtra(), toko: tokoSettings.nama || 'Service HP', slogan: tokoSettings.slogan || '', telepon: tokoSettings.telepon || '', id: currentNota.notaId, tanggal: currentNota.tanggal + ' ' + currentNota.jam, nama: unesc(currentNota.nama), nohp: currentNota.nohp || '-', device: unesc(currentNota.device), keluhan: unesc(currentNota.keluhan), biaya: currentNota.totalBiaya, dp: currentNota.dp, sisa: currentNota.sisa, footer: footers[footerKey()]?.enabled ? footers[footerKey()].text : '' };
            const width = (printer.paperSize === '80' || printer.paperSize === '75') ? 48 : 32;
            document.getElementById('thermalPreviewText').textContent = tagsToPlain(printer.buildText(data), width);
            document.getElementById('thermalPreviewModal').classList.add('active');
        }
        function closeThermalPreview() { document.getElementById('thermalPreviewModal').classList.remove('active'); }

        async function backupToDrive() {
            if (!historyData.length && !expenseData.length) { showToast('Tidak ada data untuk di-backup'); return; }
            const data = { settings:tokoSettings, history:historyData.map(({passwordDevice, ...n}) => n), logo:logoData, qris:qrisData, pengeluaran:expenseData, pembayaran:paymentData, inventori:inventoryData, stokmutasi:stockMoves, audit:auditData, openingBalances:{cash:Number(localStorage.getItem('opening_cash')||0),transfer:Number(localStorage.getItem('opening_transfer')||0),qris:Number(localStorage.getItem('opening_qris')||0),other:Number(localStorage.getItem('opening_other')||0)}, footers, sk:skText, autoWASelesai, autoWAAmbil, waNotifTemplate, exported:new Date(), note: 'Data password/pola perangkat sengaja tidak disertakan demi keamanan.' };
            const json = JSON.stringify(data, null, 2), blob = new Blob([json], {type: 'application/json'});
            const file = new File([blob], `Backup_${new Date().toISOString().slice(0,10)}.json`, { type: 'application/json' });
            if (isCapacitor()) {
                try { await shareFile(`Backup_${new Date().toISOString().slice(0,10)}.json`, textToB64(json), 'application/json', 'Backup Data Nota Service'); showToast('File backup siap dibagikan'); } catch(e) { showToast('Gagal share: ' + e.message); }
            } else if (navigator.share && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Backup Data Nota Service' }); showToast('Backup berhasil dibagikan'); } catch(e) { fallbackDownload(json); } }
            else fallbackDownload(json);
            function fallbackDownload(json) { const a = document.createElement('a'), url = URL.createObjectURL(new Blob([json], {type: 'application/json'})); a.href = url; a.download = `Backup_${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(url); showToast('File backup diunduh, silakan upload ke Drive'); }
        }

        function thermalExtra() {
            const n = currentNota || {}; const x = { detailLabel: '', detail: '', sparepart: '', garansi: '', metode: '', labelBiaya: biayaLabel(n.type), noteEstimasi: n.type === 'diagnosa' ? 'Estimasi dapat berubah. Konfirmasi bila ada selisih.' : '', rincian: [], items: null, klaim: '' };
            if (n.type === 'langsung' && n.langsung) { x.detailLabel = 'Perbaikan'; x.detail = n.langsung.detail; x.sparepart = n.langsung.sparepart; if (n.langsung.garansi > 0) { const end = new Date(new Date(n.timestamp).getTime() + n.langsung.garansi * 86400000).toLocaleDateString('id-ID'); x.garansi = `${n.langsung.garansi} hari (s/d ${end})`; } x.metode = n.metodeBayar || ''; }
            else if (n.type === 'selesai' && n.selesai) { x.detailLabel = 'Perbaikan'; x.detail = n.selesai.detail; if (n.partsUsed && n.partsUsed.length) x.sparepart = n.partsUsed.map(p => p.qty + 'x ' + unesc(p.name)).join(', '); }
            else if (n.type === 'diagnosa' && n.diagnosa) { x.detailLabel = 'Diagnosa'; x.detail = n.diagnosa.hasil; x.sparepart = n.diagnosa.sparepart; if (n.diagnosa.hargaSparepart > 0) x.rincian.push(['Sparepart', n.diagnosa.hargaSparepart]); if (n.diagnosa.biayaJasa > 0) x.rincian.push(['Jasa', n.diagnosa.biayaJasa]); }
            if (n.type === 'selesai' && n.selesai && n.selesai.garansi > 0) x.garansi = `${n.selesai.garansi} hari`;
            if (n.type === 'ambil' && n.ambil && n.ambil.status === 'diambil') { const gh = garansiHari(historyData.filter(h => (h.originalId || h.id) === n.originalId)); if (gh > 0) x.garansi = `${gh} hari (s/d ${new Date(new Date(n.timestamp).getTime() + gh * 86400000).toLocaleDateString('id-ID')})`; }
            if (n.type === 'jual' && n.jual) { x.items = n.jual.items.map(it => ({ nama: unesc(it.nama), qty: it.qty, harga: it.harga })); x.metode = n.metodeBayar || ''; }
            if ((n.type === 'ambil' || n.type === 'langsung') && n.kurangBayar > 0) x.kurang = n.kurangBayar;
            x.final = n.type === 'langsung' || n.type === 'jual' || (n.type === 'ambil' && !!(n.ambil && n.ambil.status === 'diambil'));
            if ((n.type === 'terima' || n.type === 'diagnosa') && n.estimasi) x.estimasi = unesc(n.estimasi);
            if (n.klaim) x.klaim = `Nota asal ${unesc(n.klaim.asal || '-')}`;
            try { if (localStorage.getItem('toko_qris') && isSafeImg(localStorage.getItem('toko_qris'))) x.qrisHint = localStorage.getItem('toko_qris_label') || 'Bayar QRIS: minta kasir / lihat nota digital'; } catch(_){}
            return x;
        }
        function biayaLabel(t) { if (t === 'jual') return 'Total'; return (t === 'terima' || t === 'diagnosa') ? 'Estimasi Biaya' : 'Biaya Akhir'; }
        function hitungEstimasi() {
            const sp = parseFloat(document.getElementById('hargaSparepart').value) || 0, js = parseFloat(document.getElementById('biayaJasa').value) || 0;
            if (sp || js) document.getElementById('totalBiaya').value = sp + js;
            hitungSisa();
        }
        function tambahItemJual() {
            const d = document.createElement('div'); d.className = 'jual-row'; d.style.cssText = 'padding:8px; margin-bottom:8px; border-radius:10px; background:rgba(128,128,128,.12);';
            d.innerHTML = `<input type="search" class="j-cari" placeholder="🔎 Cari barang di stok..." oninput="app.spFilterSel(this)" style="width:100%; margin-bottom:6px;"><select class="j-stok" onchange="app.spPickJual(this)" style="width:100%; margin-bottom:6px;">${spPartOptions('').replace('— pilih sparepart —', '📦 Ambil dari stok (atau ketik manual)')}</select><input type="text" class="j-nama" placeholder="Nama barang (contoh: Tempered Glass A12)" style="width:100%; margin-bottom:6px;" oninput="app.hitungJual()"><div style="display:grid; grid-template-columns:1fr 2fr 2fr auto; gap:6px; align-items:center;"><input type="number" class="j-qty" min="1" value="1" oninput="app.hitungJual()"><input type="number" class="j-harga" min="0" step="500" placeholder="Harga satuan" oninput="app.hitungJual()"><input type="number" class="j-modal" min="0" step="500" placeholder="Modal satuan" oninput="app.hitungJual()"><button type="button" onclick="this.closest('.jual-row').remove(); app.hitungJual()">✖</button></div>`;
            document.getElementById('jualItems').appendChild(d);
        }
        function bacaItemJual() {
            return Array.from(document.querySelectorAll('#jualItems .jual-row')).map(r => ({ itemId: (r.querySelector('.j-stok') || {}).value || '', nama: r.querySelector('.j-nama').value.trim(), qty: Math.max(parseInt(r.querySelector('.j-qty').value) || 1, 1), harga: parseFloat(r.querySelector('.j-harga').value) || 0, modal: parseFloat(r.querySelector('.j-modal').value) || 0 })).filter(it => it.nama);
        }
        function hitungJual() {
            const items = bacaItemJual();
            document.getElementById('totalBiaya').value = items.reduce((t, it) => t + it.qty * it.harga, 0);
            document.getElementById('modal').value = items.reduce((t, it) => t + it.qty * it.modal, 0);
            document.getElementById('dp').value = 0; hitungSisa();
        }
        function klaimOff() { klaimMode = false; }
        function mulaiKlaim() { klaimMode = true; selectType('terima'); showToast('Klaim garansi: isi No. Nota asal atau No. HP lalu tekan Cek'); }
        function garansiHari(arr) { return Math.max(0, ...arr.map(r => Number((r.langsung && r.langsung.garansi) || (r.selesai && r.selesai.garansi) || 0))); }
        function recSelesai(arr) { return arr.find(r => r.type === 'langsung' || (r.type === 'ambil' && r.ambil && r.ambil.status === 'diambil')); }
        function cariGaransi() {
            const q = document.getElementById('klaimAsal').value.trim(), info = document.getElementById('klaimInfo');
            if (!q) { info.textContent = ''; return; }
            const key = q.toLowerCase(), isPhone = !/[a-z]/i.test(q) && q.replace(/\D/g, '').length >= 9;
            const grp = id => historyData.filter(h => (h.originalId || h.id) === id).sort((x, y) => new Date(x.timestamp) - new Date(y.timestamp));
            let origin = null;
            const byId = historyData.find(h => [h.id, h.notaId, h.originalId].some(x => String(x || '').toLowerCase() === key));
            if (byId) origin = byId.originalId || byId.id;
            else if (isPhone) {
                const np = normalizePhone(q), ids = [];
                historyData.forEach(h => { if (h.nohp && normalizePhone(h.nohp) === np && !h.klaim) { const o = h.originalId || h.id; if (!ids.includes(o)) ids.push(o); } });
                origin = ids.find(o => recSelesai(grp(o))) || ids[0] || null;
            }
            if (!origin) { info.textContent = '❌ Nota / nomor tidak ditemukan di riwayat'; return; }
            const arr = grp(origin), last = arr[arr.length - 1], done = recSelesai(arr), gh = garansiHari(arr);
            document.getElementById('klaimAsal').value = origin;
            document.getElementById('nama').value = unesc(last.nama); document.getElementById('nohp').value = last.nohp || '';
            const parts = unesc(last.device).split(' '); document.getElementById('merek').value = parts[0] || ''; document.getElementById('model').value = parts.slice(1).join(' ');
            let teks;
            if (!done) teks = 'Servis asal belum selesai / belum diambil';
            else if (gh <= 0) teks = 'Servis asal tidak punya garansi tercatat';
            else { const end = new Date(new Date(done.timestamp).getTime() + gh * 86400000), sisa = Math.ceil((end - new Date()) / 86400000); teks = sisa > 0 ? `✅ Masih garansi: ${sisa} hari lagi (s/d ${end.toLocaleDateString('id-ID')})` : `❌ Garansi habis sejak ${end.toLocaleDateString('id-ID')}`; }
            info.textContent = teks;
            if (!document.getElementById('keluhan').value.trim()) document.getElementById('keluhan').value = 'Klaim garansi: ';
            showToast('Data pelanggan diisi dari nota asal');
        }
        function footerKey() { return (currentType === 'langsung' || currentType === 'jual') ? 'ambil' : currentType; }
        function selectType(type) {
            if (window._lanjutOriginalId && !CHAIN_TYPES.includes(type)) { delete window._lanjutOriginalId; resetForm(); showToast('Form dikosongkan untuk nota baru'); }
            currentType = type;
            ['terima','diagnosa','selesai','ambil','langsung','jual'].forEach(t=>{ document.getElementById(`btn${t.charAt(0).toUpperCase()+t.slice(1)}`).classList.toggle('active', t===type); });
            document.querySelectorAll('.step').forEach(s=>s.classList.toggle('active', s.dataset.step===type));
            document.getElementById('formTitle').innerHTML = {terima:'📥 Nota Penerimaan',diagnosa:'🔍 Hasil Diagnosa',selesai:'✅ Nota Selesai',ambil:'📤 Nota Ambil/Batal',langsung:'⚡ Nota Servis Langsung',jual:'🛍️ Nota Penjualan'}[type] + (klaimMode && type === 'terima' ? ' (Klaim Garansi)' : '');
            document.getElementById('kelengkapanSection').style.display = type==='terima'?'block':'none';
            document.getElementById('diagnosaSection').style.display = type==='diagnosa'?'block':'none';
            document.getElementById('selesaiSection').style.display = type==='selesai'?'block':'none';
            document.getElementById('ambilSection').style.display = type==='ambil'?'block':'none';
            document.getElementById('langsungSection').style.display = type==='langsung'?'block':'none';
            document.getElementById('labelTotalBiaya').textContent = biayaLabel(type) + ' (Rp)';
            if (type === 'langsung' || type === 'jual') klaimMode = false;
            document.getElementById('klaimSection').style.display = (klaimMode && type === 'terima') ? 'block' : 'none';
            document.getElementById('btnKlaim').classList.toggle('active', klaimMode && type === 'terima');
            document.getElementById('jualSection').style.display = type === 'jual' ? 'block' : 'none';
            const jual = type === 'jual';
            { const kb = document.getElementById('kurangBayar'), box = kb && kb.closest('.form-group'); if (box) box.style.display = (type === 'ambil' || type === 'langsung') ? '' : 'none'; }
            [['merek', '.row'], ['keluhan', '.form-group'], ['kondisiCheckboxGroup', '.form-group'], ['passwordDeviceText', '.form-group'], ['fotoPreview', '.form-group'], ['dp', '.form-group'], ['sisa', '.form-group'], ['modal', '.form-group'], ['estimasi', '.form-group']].forEach(([id, sl]) => { const el = document.getElementById(id), box = el && el.closest(sl); if (box) box.style.display = jual ? 'none' : ''; });
            ['nama', 'merek', 'model', 'keluhan'].forEach(id => { document.getElementById(id).required = !jual; });
            document.getElementById('totalBiaya').readOnly = jual;
            if (jual && !document.querySelector('#jualItems .jual-row')) tambahItemJual();
            spShowPicker(type);
        }
        function selectAmbilStatus(status) { currentStatus = status; document.getElementById('statusDiambil').classList.toggle('active', status==='diambil'); document.getElementById('statusBatal').classList.toggle('active', status==='batal'); document.getElementById('alasanBatalGroup').style.display = status==='batal'?'block':'none'; }
        function resetForm() { document.getElementById('notaForm').reset(); document.querySelectorAll('.kondisi-checkbox').forEach(c => c.classList.remove('active')); document.getElementById('kondisiLainnya').value = ''; fotoDeviceData = null; fotoDevicePath = null; let p = document.getElementById('fotoPreview'); p.innerHTML = ''; p.classList.remove('show'); resetPattern(); document.getElementById('passwordDeviceText').value = ''; klaimMode = false; document.getElementById('klaimAsal').value = ''; document.getElementById('klaimInfo').textContent = ''; document.getElementById('jualItems').innerHTML = ''; spClearPicker(); delete window._spEditFrom; delete window._lanjutOriginalId; selectType('terima'); selectAmbilStatus('diambil'); hitungSisa(); localStorage.removeItem('nota_draft'); }
        function buatNotaBaru() { resetForm(); document.getElementById('previewCard').classList.remove('active'); document.getElementById('formCard').classList.add('active'); currentNota = null; delete window._lanjutOriginalId; delete window._spEditFrom; }
        function backToForm() { const wasPreview = document.getElementById('previewCard').classList.contains('active'); document.querySelectorAll('.history-card, .settings-card, .preview-card').forEach(c=>c.classList.remove('active')); document.getElementById('formCard').classList.add('active'); if (currentNota && wasPreview) window._spEditFrom = currentNota.id; delete window._lanjutOriginalId; }
        function showHistory() { renderHistory(); document.querySelectorAll('.form-card, .preview-card, .settings-card, #stokCard').forEach(c=>c.classList.remove('active')); document.getElementById('historyCard').classList.add('active'); }
        function showSettings() {
            document.getElementById('settingNamaToko').value = tokoSettings.nama||'';
            document.getElementById('settingSlogan').value = tokoSettings.slogan||'';
            document.getElementById('settingPrimaryColor').value = tokoSettings.primaryColor||'#667eea';
            document.getElementById('primaryColorPreview').style.backgroundColor = tokoSettings.primaryColor||'#667eea';
            document.getElementById('settingAlamat').value = tokoSettings.alamat||'';
            document.getElementById('settingTelepon').value = tokoSettings.telepon||'';
            document.getElementById('templateText').value = localStorage.getItem('wa_template')||'';
            document.getElementById('printerSize').value = localStorage.getItem('printer_size')||'58';
            autoWASelesai = localStorage.getItem('auto_wa_selesai') === 'true'; autoWAAmbil = localStorage.getItem('auto_wa_ambil') === 'true';
            document.getElementById('autoWASelesai').checked = autoWASelesai; document.getElementById('autoWAAmbil').checked = autoWAAmbil; document.getElementById('waApp').value = localStorage.getItem('wa_app') || 'auto';
            waNotifTemplate = localStorage.getItem('wa_notif_template') || "Halo {nama}, perangkat {device} Anda sudah *{status}*. Silakan ambil di toko kami. Terima kasih 🙏\n\n{nota_id}";
            document.getElementById('waNotifTemplate').value = waNotifTemplate;
            let f = JSON.parse(localStorage.getItem('footers_settings')||'{}'); footers = {...footers, ...f};
            document.getElementById('footerTerimaText').value = footers.terima.text; document.getElementById('footerTerimaEnabled').checked = footers.terima.enabled;
            document.getElementById('footerDiagnosaText').value = footers.diagnosa.text; document.getElementById('footerDiagnosaEnabled').checked = footers.diagnosa.enabled;
            document.getElementById('footerSelesaiText').value = footers.selesai.text; document.getElementById('footerSelesaiEnabled').checked = footers.selesai.enabled;
            document.getElementById('footerAmbilText').value = footers.ambil.text; document.getElementById('footerAmbilEnabled').checked = footers.ambil.enabled;
            document.getElementById('skText').value = skText;
            if(logoData) document.getElementById('logoPreview').innerHTML = `<img src="${logoData}" style="max-width:100%;max-height:100%;">`;
            document.getElementById('printerDeviceId').value = lastPrinterId;
            autoPrint = localStorage.getItem('auto_print') === 'true'; document.getElementById('autoPrintCheckbox').checked = autoPrint;
            // Tampilkan SN & status lisensi di Pengaturan
            const sn = ensureSN();
            const snEl = document.getElementById('settingSN');
            if (snEl) snEl.value = sn || '';
            const stEl = document.getElementById('settingLicenseStatus');
            if (stEl) {
                if (isActivated()) {
                    stEl.innerHTML = '✅ Status: <span style="color:#4caf50;">Full Version</span>';
                } else {
                    const sisa = getRemainingTrial();
                    stEl.innerHTML = '⏳ Status: Trial — <b>' + sisa + '</b> transaksi tersisa';
                }
            }
            updateLicenseUI();
            document.querySelectorAll('.form-card, .preview-card, .history-card').forEach(c=>c.classList.remove('active'));
            document.getElementById('settingsCard').classList.add('active');
        }
        function saveSettings() {
            tokoSettings = { nama: document.getElementById('settingNamaToko').value, slogan: document.getElementById('settingSlogan').value, primaryColor: document.getElementById('settingPrimaryColor').value, alamat: document.getElementById('settingAlamat').value, telepon: document.getElementById('settingTelepon').value };
            localStorage.setItem('toko_settings', JSON.stringify(tokoSettings));
            try {
                const ql = (document.getElementById('settingQrisLabel') || {}).value || '';
                localStorage.setItem('toko_qris_label', ql);
                const qa = document.getElementById('qrisShowAlways');
                localStorage.setItem('toko_qris_always', qa && qa.checked ? 'true' : 'false');
            } catch (_) {}
            localStorage.setItem('wa_template', document.getElementById('templateText').value);
            localStorage.setItem('printer_size', document.getElementById('printerSize').value);
            autoWASelesai = document.getElementById('autoWASelesai').checked; autoWAAmbil = document.getElementById('autoWAAmbil').checked;
            localStorage.setItem('auto_wa_selesai', autoWASelesai); localStorage.setItem('auto_wa_ambil', autoWAAmbil); localStorage.setItem('wa_app', document.getElementById('waApp').value);
            waNotifTemplate = document.getElementById('waNotifTemplate').value; localStorage.setItem('wa_notif_template', waNotifTemplate);
            footers = { terima: {text: document.getElementById('footerTerimaText').value, enabled: document.getElementById('footerTerimaEnabled').checked}, diagnosa: {text: document.getElementById('footerDiagnosaText').value, enabled: document.getElementById('footerDiagnosaEnabled').checked}, selesai: {text: document.getElementById('footerSelesaiText').value, enabled: document.getElementById('footerSelesaiEnabled').checked}, ambil: {text: document.getElementById('footerAmbilText').value, enabled: document.getElementById('footerAmbilEnabled').checked} };
            localStorage.setItem('footers_settings', JSON.stringify(footers));
            skText = document.getElementById('skText').value; localStorage.setItem('sk_text', skText);
            autoPrint = document.getElementById('autoPrintCheckbox').checked; localStorage.setItem('auto_print', autoPrint);
            document.getElementById('tokoNameDisplay').innerText = tokoSettings.nama||'Nota Service HP';
            document.getElementById('tokoSloganDisplay').innerText = tokoSettings.slogan||'';
            if(tokoSettings.primaryColor){ document.documentElement.style.setProperty('--primary', tokoSettings.primaryColor); document.getElementById('themeColorMeta').setAttribute('content', tokoSettings.primaryColor); }
            // SN mengikuti Nama Toko + Alamat + Telepon; jika berubah, aktivasi lama di-reset
            ensureSN();
            updateLicenseUI();
            showToast('Pengaturan disimpan'); backToForm();
        }
        function handleLogo(e) {
            let f = e.target.files[0]; if(!f) return; if(f.size > 500*1024) return showToast('Logo max 500KB');
            let r = new FileReader();
            r.onload = ev => { logoData = ev.target.result; localStorage.setItem('toko_logo', logoData); document.getElementById('logoPreview').innerHTML = `<img src="${logoData}" style="max-width:100%;max-height:100%;">`; document.getElementById('headerIcon').innerHTML = `<img src="${logoData}" style="width:100%;height:100%;object-fit:contain;">`; };
            r.readAsDataURL(f);
        }
        function removeLogo() { logoData = null; localStorage.removeItem('toko_logo'); document.getElementById('logoPreview').innerHTML = '<span>Belum ada logo</span>'; document.getElementById('headerIcon').innerHTML = '📱'; showToast('Logo dihapus'); }

        function handleQris(e) {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            if (f.size > 500 * 1024) { showToast('Gambar QRIS max 500KB'); e.target.value = ''; return; }
            const r = new FileReader();
            r.onload = ev => {
                if (!isSafeImg(ev.target.result) && !(typeof ev.target.result === 'string' && ev.target.result.startsWith('data:image/'))) {
                    showToast('Format gambar tidak didukung'); return;
                }
                qrisData = ev.target.result;
                localStorage.setItem('toko_qris', qrisData);
                const qp = document.getElementById('qrisPreview');
                if (qp) qp.innerHTML = `<img src="${qrisData}" style="max-width:100%;max-height:100%;">`;
                showToast('QRIS disimpan');
            };
            r.readAsDataURL(f);
        }
        function removeQris() {
            qrisData = null;
            localStorage.removeItem('toko_qris');
            const qp = document.getElementById('qrisPreview');
            if (qp) qp.innerHTML = '<span>Belum ada QRIS</span>';
            showToast('QRIS dihapus');
        }
        function toggleDarkMode() { document.body.classList.toggle('dark-mode'); localStorage.setItem('dark_mode', document.body.classList.contains('dark-mode')); }
        async function renderHistory() {
            await loadHistory();
            let search = document.getElementById('searchHistory').value.toLowerCase(), filter = document.getElementById('filterType').value;
            let filtered = search ? historyData.filter(h => h.nama.toLowerCase().includes(search) || h.nohp.includes(search) || h.device.toLowerCase().includes(search)) : historyData;
            if(filter) filtered = filtered.filter(h => h.type === filter);
            let now = new Date(), bulanIni = historyData.filter(h => { let d = new Date(h.timestamp); return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); }).length;
            let selesai = historyData.filter(h => (h.type==='ambil' && h.ambil?.status==='diambil') || h.type==='langsung' || h.type==='jual').length, pending = historyData.filter(h => h.type==='terima'||h.type==='diagnosa').length;
            document.getElementById('statTotal').innerText = historyData.length; document.getElementById('statBulanIni').innerText = bulanIni; document.getElementById('statSelesai').innerText = selesai; document.getElementById('statPending').innerText = pending;
            let list = document.getElementById('historyList');
            if(!filtered.length){ list.innerHTML='<div style="text-align:center; padding:20px;">Tidak ada data</div>'; return; }
            list.innerHTML = filtered.map(h => `<div class="history-item" data-id="${escapeHtml(h.id)}"><div class="history-header"><div class="history-name">${escapeHtml(h.nama)}</div><div class="history-type ${h.type}">${h.type}</div></div><div style="font-size:13px;">📱 ${escapeHtml(h.device)} | 💰 Rp ${formatRupiah(h.totalBiaya)}</div><div style="font-size:12px;">${h.notaId} | ${h.tanggal}</div></div>`).join('');
        }
        async function loadHistoryItem(id) { let n = historyData.find(h => h.id === id); if(n){ currentNota = n; currentType = n.type; renderPreview(); updateWorkflowButtons(); document.getElementById('historyCard').classList.remove('active'); document.getElementById('previewCard').classList.add('active'); } }
        function exportCSV() { if(!historyData.length) return; let csv = '\ufeffNo,ID,OriginalID,Tanggal,Jam,Tipe,Nama,NoHP,Device,Keluhan,Kondisi,TotalBiaya,DP,Sisa,Catatan\n'; historyData.forEach((h,i)=>{ csv += [i+1,csvCell(h.notaId),csvCell(h.originalId||h.id),csvCell(h.tanggal),csvCell(h.jam),csvCell(h.type),csvCell(h.nama),csvCell(h.nohp),csvCell(h.device),csvCell(h.keluhan),csvCell((h.kondisi||[]).join(';')),h.totalBiaya||0,h.dp||0,h.sisa||0,csvCell(h.catatan||'')].join(',') + '\n'; }); if (isCapacitor()) { shareFile(`Riwayat_${new Date().toISOString().slice(0,10)}.csv`, textToB64(csv), 'text/csv', 'Riwayat Nota').catch(e => showToast('Gagal: ' + e.message)); return; } let blob = new Blob([csv],{type:'text/csv;charset=utf-8;'}), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `Riwayat_${new Date().toISOString().slice(0,10)}.csv`; a.click(); }
        async function exportJSON() {
            if (isCapacitor()) { return backupToDrive(); }
            if (isEncryptionEnabled() && !cryptoKey) { showToast('Buka kunci PIN dulu sebelum backup'); showPinLock('unlock'); return; }
            let data = { settings:tokoSettings, history:historyData.map(({passwordDevice, ...n}) => n), logo:logoData, qris:qrisData, pengeluaran:expenseData, pembayaran:paymentData, inventori:inventoryData, stokmutasi:stockMoves, audit:auditData, openingBalances:{cash:Number(localStorage.getItem('opening_cash')||0),transfer:Number(localStorage.getItem('opening_transfer')||0),qris:Number(localStorage.getItem('opening_qris')||0),other:Number(localStorage.getItem('opening_other')||0)}, footers, sk:skText, autoWASelesai, autoWAAmbil, waNotifTemplate, exported:new Date(), note: 'Data password/pola perangkat sengaja tidak disertakan demi keamanan.' };
            let json = JSON.stringify(data, null, 2);
            let out = json, fname = `Backup_${new Date().toISOString().slice(0,10)}.json`;
            if (isEncryptionEnabled() && cryptoKey) {
                const enc = await encryptBackupPayload(json, cryptoKey);
                out = JSON.stringify(enc, null, 2);
                fname = `Backup_Encrypted_${new Date().toISOString().slice(0,10)}.json`;
            }
            let blob = new Blob([out], {type:'application/json'}), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
            localStorage.setItem('last_backup_at', new Date().toISOString());
        }
        async function restoreData(e) {
            let f = e.target.files[0]; if(!f) return;
            if(!confirm('⚠️ Restore akan MENIMPA nota ber-ID sama dan menimpa pengaturan. Nota lain yang sudah ada tetap dipertahankan. Lanjutkan?')) { e.target.value=''; return; }
            showLoading();
            let r = new FileReader();
            r.onload = async ev => {
                try {
                    let d = JSON.parse(ev.target.result);
                    if(!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Format backup tidak valid');
                    // Backup terenkripsi?
                    if (d.format === 'nshp-encrypted-backup') {
                        if (!cryptoKey) throw new Error('Backup terenkripsi — buka kunci PIN dulu, lalu restore lagi');
                        const plain = await decryptBackupPayload(d, cryptoKey);
                        d = JSON.parse(plain);
                    }
                    let notas = Array.isArray(d.history) ? d.history.map(sanitizeNota).filter(Boolean) : [];
                    if(Array.isArray(d.history) && d.history.length && !notas.length) throw new Error('Tidak ada nota valid di backup');
                    for(let n of notas) await saveToDB(n);
                    let exps = Array.isArray(d.pengeluaran) ? d.pengeluaran.map(sanitizeExpense).filter(Boolean) : [];
                    for(let x of exps) await saveExpense(x);
                    for (const x of (Array.isArray(d.pembayaran) ? d.pembayaran : [])) if (validPayment(x)) await putStore('pembayaran', x);
                    for (const x of (Array.isArray(d.inventori) ? d.inventori : [])) if (validInventory(x)) await putStore('inventori', x);
                    for (const x of (Array.isArray(d.stokmutasi) ? d.stokmutasi : [])) if (validMove(x)) await putStore('stokmutasi', x);
                    for (const x of (Array.isArray(d.audit) ? d.audit : [])) if (x && x.id && x.action) await putStore('audit', x);
                    if(d.openingBalances && typeof d.openingBalances === 'object') { for (const [src,dst] of [['cash','opening_cash'],['transfer','opening_transfer'],['qris','opening_qris'],['other','opening_other']]) if (Number.isFinite(Number(d.openingBalances[src]))) localStorage.setItem(dst,String(Math.max(0,Number(d.openingBalances[src])))); }
                    if(d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings)) { tokoSettings = {}; ['nama','slogan','alamat','telepon','primaryColor'].forEach(k => { if(typeof d.settings[k] === 'string') tokoSettings[k] = d.settings[k]; }); localStorage.setItem('toko_settings', JSON.stringify(tokoSettings)); }
                    if(d.logo) { if(isSafeImg(d.logo)) { logoData = d.logo; localStorage.setItem('toko_logo', logoData); } }
                    if(d.qris) { if(isSafeImg(d.qris)) { qrisData = d.qris; localStorage.setItem('toko_qris', qrisData); } }
                    if(d.footers && typeof d.footers === 'object') { ['terima','diagnosa','selesai','ambil'].forEach(k => { const x = d.footers[k]; if(x && typeof x === 'object') footers[k] = { text: String(x.text||''), enabled: !!x.enabled }; }); localStorage.setItem('footers_settings', JSON.stringify(footers)); }
                    if(typeof d.sk === 'string') { skText = d.sk; localStorage.setItem('sk_text', skText); }
                    if(typeof d.autoWASelesai === 'boolean') { autoWASelesai = d.autoWASelesai; localStorage.setItem('auto_wa_selesai', autoWASelesai); }
                    if(typeof d.autoWAAmbil === 'boolean') { autoWAAmbil = d.autoWAAmbil; localStorage.setItem('auto_wa_ambil', autoWAAmbil); }
                    if(typeof d.waNotifTemplate === 'string') { waNotifTemplate = d.waNotifTemplate; localStorage.setItem('wa_notif_template', waNotifTemplate); }
                    showToast(`Restore berhasil (${notas.length} nota, ${exps.length} pengeluaran), reload...`); setTimeout(()=>location.reload(),1200);
                } catch(err) { showToast('Gagal restore: ' + err.message); }
                hideLoading(); e.target.value='';
            };
            r.onerror = () => { hideLoading(); showToast('Gagal membaca file'); };
            r.readAsText(f);
        }
        function clearAllData() {
            if(!confirm('⚠️ Hapus semua data? Tidak bisa dikembalikan!')) return;
            if(historyData.length && confirm('Unduh backup dulu sebelum menghapus? (disarankan)')) { try { exportJSON(); } catch(e) {} }
            if(!confirm('Yakin hapus SEMUA data sekarang?')) return;
            ['wa_template','wa_notif_template','auto_wa_selesai','auto_wa_ambil','nota_draft','printer_size','last_printer_id','footers_settings','auto_print','toko_settings','toko_logo','toko_qris','toko_qris_label','toko_qris_always','sk_text','dark_mode','mask_pwd','dp_batal_mode','opening_cash','opening_transfer','opening_qris','opening_other','last_backup_at','nota_cloud_config'].forEach(k => localStorage.removeItem(k));
            if(db) { db.close(); db = null; }
            const req = indexedDB.deleteDatabase('NotaServiceDB');
            const done = () => { showToast('Semua data dihapus'); setTimeout(()=>location.reload(),1000); };
            req.onsuccess = done; req.onerror = done; req.onblocked = done;
        }

        async function init() {
            await initDB();
            let saved = localStorage.getItem('toko_settings'); if(saved) tokoSettings = JSON.parse(saved);
            logoData = localStorage.getItem('toko_logo'); if(!isSafeImg(logoData)) logoData = null; if(logoData) document.getElementById('headerIcon').innerHTML = `<img src="${logoData}" style="width:100%;height:100%;object-fit:contain;">`;
            qrisData = localStorage.getItem('toko_qris'); if(!isSafeImg(qrisData)) qrisData = null;
            if(localStorage.getItem('dark_mode') === 'true') document.body.classList.add('dark-mode');
            let f = localStorage.getItem('footers_settings'); if(f) footers = JSON.parse(f);
            skText = localStorage.getItem('sk_text') || '• Resiko kehilangan data bukan tanggung jawab kami.\n• Barang tidak diambil dalam 30 hari dianggap hangus.\n• Garansi hanya berlaku pada sparepart yang diganti.';
            if(!localStorage.getItem('wa_template')) localStorage.setItem('wa_template', '*{toko}*\n━━━━━━━━━━━━━━━\n{type_badge}\n━━━━━━━━━━━━━━━\n\n🆔 No: *{nota_id}*\n📅 {tanggal} | ⏰ {jam}\n\n👤 *Pelanggan:* {nama}\n📱 *Device:* {device}\n\n📋 *Keluhan:*\n{keluhan}\n\n{kelengkapan_line}\n💰 *Estimasi Biaya:* Rp {biaya}\n⏳ *Estimasi Waktu:* {estimasi}\n\n📝 *Catatan:* {catatan}\n\n━━━━━━━━━━━━\n{footer}');
            autoWASelesai = localStorage.getItem('auto_wa_selesai') === 'true'; autoWAAmbil = localStorage.getItem('auto_wa_ambil') === 'true';
            waNotifTemplate = localStorage.getItem('wa_notif_template') || "Halo {nama}, perangkat {device} Anda sudah *{status}*. Silakan ambil di toko kami. Terima kasih 🙏\n\n{nota_id}";
            lastPrinterId = localStorage.getItem('last_printer_id') || ''; autoPrint = localStorage.getItem('auto_print') === 'true'; document.getElementById('autoPrintCheckbox').checked = autoPrint;
            document.getElementById('tokoNameDisplay').innerText = tokoSettings.nama||'Nota Service HP'; document.getElementById('tokoSloganDisplay').innerText = tokoSettings.slogan||'';
            if(tokoSettings.primaryColor){ document.documentElement.style.setProperty('--primary', tokoSettings.primaryColor); document.getElementById('themeColorMeta').setAttribute('content', tokoSettings.primaryColor); }
            let draft = localStorage.getItem('nota_draft');
            if(draft){ let d = JSON.parse(draft); if((new Date() - new Date(d.timestamp)) < 24*3600000){ document.getElementById('nama').value = d.nama||''; document.getElementById('nohp').value = d.nohp||''; document.getElementById('merek').value = d.merek||''; document.getElementById('model').value = d.model||''; document.getElementById('keluhan').value = d.keluhan||''; } }
            document.querySelectorAll('#nama, #merek, #model').forEach(el => el.addEventListener('blur', () => { el.value = capWords(el.value); }));
    document.querySelectorAll('#nama, #nohp, #merek, #model, #keluhan').forEach(inp => inp.addEventListener('input',()=>{ localStorage.setItem('nota_draft', JSON.stringify({ nama:document.getElementById('nama').value, nohp:document.getElementById('nohp').value, merek:document.getElementById('merek').value, model:document.getElementById('model').value, keluhan:document.getElementById('keluhan').value, timestamp:new Date() })); }));
            document.querySelectorAll('.kondisi-checkbox').forEach(el => el.addEventListener('click',()=>el.classList.toggle('active')));
            if(!navigator.onLine) document.getElementById('connectionStatus').classList.add('offline');
            initPatternCanvas();
            let mi = document.getElementById('passwordDeviceText');
            if (mi) mi.addEventListener('input', function() { if (this.value.trim()) { patternPath = []; drawPatternCanvas(); document.getElementById('passwordDevice').value = this.value; document.getElementById('patternInfo').innerHTML = `📝 Teks: ${this.value}`; } else updatePatternOutput(); });
            // Lisensi: pastikan SN ada & update status trial
            ensureSN();
            updateLicenseUI();
            updateCryptoUI();
            // Jika enkripsi aktif, minta PIN sebelum memuat data
            if (isEncryptionEnabled()) {
                cryptoUnlocked = false;
                cryptoKey = null;
                showPinLock('unlock');
                // loadHistory dipanggil setelah PIN benar (di submitPinLock)
            } else {
                cryptoUnlocked = true;
                await loadHistory();
            }
        }

        async function sendAutoWA(nota, statusType) {
            if (!nota.nohp) return;
            let template = waNotifTemplate || "Halo {nama}, perangkat {device} Anda sudah *{status}*. Silakan ambil di toko kami. Terima kasih 🙏\n\n{nota_id}";
            let statusText = statusType === 'selesai' ? 'SELESAI diperbaiki' : 'SIAP DIAMBIL';
            let msg = template.replace(/{nama}/g, () => unesc(nota.nama)).replace(/{device}/g, () => unesc(nota.device)).replace(/{nota_id}/g, nota.notaId).replace(/{toko}/g, tokoSettings.nama || 'Service HP').replace(/{status}/g, statusText);
            window.open(`https://wa.me/${normalizePhone(nota.nohp)}?text=${encodeURIComponent(msg)}`, '_blank');
            showToast(`Notifikasi WA dikirim ke ${nota.nama}`);
        }


        // ============ PEMBUKUAN: LAPORAN, PENGELUARAN, ARUS KAS ============
        const KAT_OPERASIONAL = ['Sewa Tempat', 'Listrik/Internet', 'Gaji/Upah', 'Transport', 'Pulsa/Alat Kerja', 'Lain-lain'];
        const KAT_STOK = 'Beli Stok/Sparepart';
        const METODE_LIST = ['Tunai', 'Transfer', 'QRIS'];
        let lapMode = 'bulanan', lapVal = null;

        function dKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
        function ymKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
        function defaultLapVal(mode) { const n = new Date(); return mode === 'harian' ? dKey(n) : mode === 'tahunan' ? String(n.getFullYear()) : ymKey(n); }
        function inP(tgl) { return !!lapVal && (lapMode === 'harian' ? tgl === lapVal : String(tgl).startsWith(lapVal)); }
        function rp(n) { n = Math.round(Number(n) || 0); return (n < 0 ? '-' : '') + 'Rp ' + formatRupiah(Math.abs(n)); }

        // ---- Penyimpanan pengeluaran (IndexedDB, store 'pengeluaran') ----
        function sanitizeExpense(x) {
            if (!x || typeof x !== 'object') return null;
            const jumlah = Math.round(Number(x.jumlah));
            if (!x.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.tanggal)) || !(jumlah > 0)) return null;
            return { id: String(x.id).replace(/[^\w-]/g, ''), tanggal: String(x.tanggal), kategori: String(x.kategori || 'Lain-lain').slice(0, 40), ket: String(x.ket || '').slice(0, 200), jumlah, metode: METODE_LIST.includes(x.metode) ? x.metode : 'Tunai' };
        }
        async function getAllExpensesRaw() { if (!db) await initDB(); return new Promise((res, rej) => { const req = db.transaction(['pengeluaran'], 'readonly').objectStore('pengeluaran').getAll(); req.onsuccess = () => res(req.result); req.onerror = rej; }); }
        async function getAllExpenses() { return decryptList(await getAllExpensesRaw()); }
        async function saveExpense(x) {
            if (!db) await initDB();
            const toStore = await maybeEncryptForStore(x);
            return new Promise((res, rej) => { const tx = db.transaction(['pengeluaran'], 'readwrite'); tx.objectStore('pengeluaran').put(toStore); tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
        }
        async function deleteExpenseDB(id) { if (!db) await initDB(); return new Promise((res, rej) => { const tx = db.transaction(['pengeluaran'], 'readwrite'); tx.objectStore('pengeluaran').delete(id); tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; }); }

        // ---- Pengelompokan nota menjadi satu baris per servis ----
        function groupServis() {
            const g = {};
            historyData.forEach(h => { const k = (!CHAIN_TYPES.includes(h.type) && h.type !== 'klaim') ? h.id : (h.originalId || h.id); (g[k] = g[k] || []).push(h); });
            return Object.values(g).map(arr => {
                arr.sort((x, y) => new Date(x.timestamp) - new Date(y.timestamp));
                const last = arr[arr.length - 1];
                let status = 'proses';
                if (last.type === 'langsung' || last.type === 'jual') status = 'diambil'; else if (last.type === 'ambil') status = (last.ambil && last.ambil.status === 'batal') ? 'batal' : 'diambil';
                const dpAmt = Math.max(...arr.map(r => Number(r.dp) || 0));
                const kurang = status === 'diambil' ? Math.min(Math.max(Number(last.kurangBayar) || 0, 0), Math.max((Number(last.totalBiaya) || 0) - dpAmt, 0)) : 0;
                const dpRow = arr.find(r => (Number(r.dp) || 0) > 0);
                return { id: CHAIN_TYPES.includes(last.type) ? (last.originalId || last.id) : last.id, nama: unesc(last.nama), device: last.type === 'jual' ? unesc(last.keluhan) : unesc(last.device), total: Number(last.totalBiaya) || 0, dp: Number(last.dp) || 0, dpAmt, kurang, dpTs: dpRow ? dpRow.timestamp : null, modal: Number(last.modal) || 0, metode: last.metodeBayar || 'Tunai', status, ts: last.timestamp, jenis: last.type === 'jual' ? 'jual' : (arr.some(r => r.klaim) ? 'klaim' : 'servis'), sub: (last.type === 'diagnosa' && last.diagnosa) ? last.diagnosa.status : '' };
            }).sort((x, y) => new Date(y.ts) - new Date(x.ts));
        }

        // ---- Buku kas: semua uang masuk/keluar menurut tanggal terjadinya ----
        function buildKas(data) {
            const ev = [];
            const add = (tgl, jenis, ket, masuk, keluar, metode) => ev.push({ tgl, jenis, ket, masuk, keluar, metode: METODE_LIST.includes(metode) ? metode : 'Tunai' });
            const refund = localStorage.getItem('dp_batal_mode') !== 'hangus';
            data.forEach(s => {
                const ket = s.nama + ' - ' + s.device;
                // 1) DP / pelunasan / refund DP yang tercatat di nota
                notaKasEvents(s, { refundDp: refund, dKey }).forEach(e => add(e.tgl, e.jenis, ket, e.masuk, e.keluar, s.metode));
                // 2) Pembayaran manual (cicilan kurang bayar, refund, koreksi) — selalu tambahan di atas nota
                paymentData.filter(p => p.serviceId === s.id).forEach(p => add(p.date, p.kind === 'refund' ? 'Refund/Koreksi' : 'Pembayaran', ket + (p.note ? ' (' + p.note + ')' : ''), p.kind === 'masuk' ? p.amount : 0, p.kind === 'refund' ? p.amount : 0, p.method));
            });
            expenseData.forEach(x => add(x.tanggal, x.kategori === KAT_STOK ? 'Beli Stok' : 'Pengeluaran', x.kategori + (x.ket ? ': ' + x.ket : ''), 0, x.jumlah, x.metode));
            return ev.sort((a, b) => a.tgl.localeCompare(b.tgl));
        }

        // ---- Perhitungan laporan untuk periode terpilih ----
        function hitungLaporan() {
            if (!lapVal) lapVal = defaultLapVal(lapMode);
            const sum = (arr, f) => arr.reduce((t, s) => t + f(s), 0);
            const data = groupServis();
            const selesai = data.filter(s => s.status === 'diambil' && inP(dKey(s.ts)));
            const batal = data.filter(s => s.status === 'batal' && inP(dKey(s.ts)));
            const proses = data.filter(s => s.status === 'proses');
            const omzet = sum(selesai, s => s.total), modal = sum(selesai, s => s.modal), labaKotor = omzet - modal;
            const hangus = localStorage.getItem('dp_batal_mode') === 'hangus';
            const dpBatal = sum(batal, s => s.dpAmt), pendLain = hangus ? dpBatal : 0;
            const exps = expenseData.filter(x => inP(x.tanggal)).sort((a, b) => b.tanggal.localeCompare(a.tanggal));
            const opex = sum(exps.filter(x => x.kategori !== KAT_STOK), x => x.jumlah);
            const stok = sum(exps.filter(x => x.kategori === KAT_STOK), x => x.jumlah);
            const labaBersih = labaKotor + pendLain - opex;
            const kas = buildKas(data).filter(e => inP(e.tgl));
            const masuk = sum(kas, e => e.masuk), keluar = sum(kas, e => e.keluar);
            const metode = {}; METODE_LIST.forEach(m => { metode[m] = { masuk: sum(kas.filter(e => e.metode === m), e => e.masuk), keluar: sum(kas.filter(e => e.metode === m), e => e.keluar) }; });
            const paidFor = s => paidSoFar(s, paymentData);
            const dpProses = sum(proses, s => paidFor(s)), sisaProses = sum(proses, s => Math.max(s.total - paidFor(s), 0));
            const piutang = data.filter(s => piutangOf(s, paymentData) > 0).map(s => ({ ...s, piutang: piutangOf(s, paymentData) })), piutangTotal = sum(piutang, s => s.piutang);
            const perKat = {}; exps.forEach(x => { perKat[x.kategori] = (perKat[x.kategori] || 0) + x.jumlah; });
            return { data, selesai, batal, proses, omzet, modal, labaKotor, hangus, dpBatal, pendLain, exps, opex, stok, labaBersih, kas, masuk, keluar, saldo: masuk - keluar, metode, dpProses, sisaProses, piutang, piutangTotal, perKat };
        }

        // ---- UI ----
        async function showLaporan() {
            const box = document.getElementById('laporanBox');
            if (box.style.display === 'block') { box.style.display = 'none'; return; }
            await loadHistory();
            box.style.display = 'block'; renderLaporan();
        }
        function setLapMode(m) { if (!['harian', 'bulanan', 'tahunan'].includes(m)) return; lapMode = m; lapVal = defaultLapVal(m); renderLaporan(); }
        function setLapVal(v) {
            const ok = lapMode === 'harian' ? /^\d{4}-\d{2}-\d{2}$/.test(v) : lapMode === 'bulanan' ? /^\d{4}-\d{2}$/.test(v) : /^\d{4}$/.test(v);
            if (!ok) return; lapVal = v; renderLaporan();
        }
        function setDpBatalMode(m) { localStorage.setItem('dp_batal_mode', m === 'hangus' ? 'hangus' : 'refund'); renderLaporan(); }

        function renderLaporan() {
            const box = document.getElementById('laporanBox');
            const L = hitungLaporan();
            const card = (l, v, strong) => `<div style="flex:1 1 45%; padding:10px; border-radius:10px; background:rgba(128,128,128,${strong ? '.25' : '.12'});"><div style="font-size:11px; opacity:.7;">${l}</div><div style="font-weight:bold;">${v}</div></div>`;
            const th = 'style="text-align:right; padding:3px 0;"';
            const sec = t => `<div style="margin:14px 0 6px; font-weight:bold;">${t}</div>`;
            const tableWrap = h => `<div style="overflow-x:auto;"><table style="width:100%; font-size:12px; border-collapse:collapse;">${h}</table></div>`;
            const inputType = lapMode === 'harian' ? 'date' : lapMode === 'bulanan' ? 'month' : 'number';
            const inputExtra = lapMode === 'tahunan' ? ' min="2000" max="2100" inputmode="numeric"' : '';
            const rowsSelesai = L.selesai.map(s => `<tr><td style="padding:3px 0;">${escapeHtml(s.nama)}<br><small>${escapeHtml(s.device)}${s.jenis === 'klaim' ? ' 🛡️ klaim' : ''}${s.jenis === 'jual' ? ' 🛍️' : ''} · ${escapeHtml(s.metode)}</small></td><td ${th}>${formatRupiah(s.total)}</td><td ${th}>${formatRupiah(s.modal)}</td><td ${th}>${formatRupiah(s.total - s.modal)}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center; padding:8px;">Belum ada transaksi selesai di periode ini</td></tr>';
            const rowsProses = L.proses.map(s => { const ps=paymentData.filter(p=>p.serviceId===s.id); const paid=paidSoFar(s, paymentData); return `<tr><td style="padding:3px 0;">${escapeHtml(s.nama)}<br><small>${escapeHtml(s.device)}${s.sub === 'sparepart' ? ' · menunggu sparepart' : ''}</small></td><td ${th}>${formatRupiah(s.total)}</td><td ${th}>${formatRupiah(paid)}</td><td ${th}>${formatRupiah(Math.max(s.total - paid, 0))}</td></tr>`; }).join('');
            const rowsExp = L.exps.map(x => `<tr><td style="padding:3px 0;">${escapeHtml(x.tanggal.split('-').reverse().join('/'))}<br><small>${escapeHtml(x.kategori)}${x.ket ? ': ' + escapeHtml(x.ket) : ''} · ${escapeHtml(x.metode)}</small></td><td ${th}>${formatRupiah(x.jumlah)}</td><td ${th}><button class="btn-icon" style="background:#f0f0f0;" onclick="app.hapusPengeluaran('${x.id}')">🗑️</button></td></tr>`).join('') || '<tr><td colspan="3" style="text-align:center; padding:8px;">Belum ada pengeluaran di periode ini</td></tr>';
            const rowsKat = Object.keys(L.perKat).map(k => `<tr><td style="padding:3px 0;">${escapeHtml(k)}</td><td ${th}>${formatRupiah(L.perKat[k])}</td></tr>`).join('');
            const rowsMetode = METODE_LIST.map(m => `<tr><td style="padding:3px 0;">${m}</td><td ${th}>${formatRupiah(L.metode[m].masuk)}</td><td ${th}>${formatRupiah(L.metode[m].keluar)}</td><td ${th}>${rp(L.metode[m].masuk - L.metode[m].keluar)}</td></tr>`).join('');
            box.innerHTML = `<div style="padding:12px; border-radius:12px; border:1px solid rgba(128,128,128,.3);">
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;"><strong>📈</strong>
                    <select id="lapModeSel" onchange="app.setLapMode(this.value)" style="flex:0 0 38%;"><option value="harian"${lapMode === 'harian' ? ' selected' : ''}>Harian</option><option value="bulanan"${lapMode === 'bulanan' ? ' selected' : ''}>Bulanan</option><option value="tahunan"${lapMode === 'tahunan' ? ' selected' : ''}>Tahunan</option></select>
                    <input type="${inputType}"${inputExtra} id="lapValInput" value="${lapVal}" onchange="app.setLapVal(this.value)" style="flex:1;"></div>

                ${sec('Laba / Rugi')}
                <div style="display:flex; flex-wrap:wrap; gap:8px;">
                    ${card('Transaksi selesai', L.selesai.length + ' (servis ' + L.selesai.filter(s => s.jenis === 'servis').length + ' | jual ' + L.selesai.filter(s => s.jenis === 'jual').length + ' | klaim ' + L.selesai.filter(s => s.jenis === 'klaim').length + ')')}${card('Omzet', rp(L.omzet))}
                    ${card('Modal sparepart/barang', rp(L.modal))}${card('Laba kotor', rp(L.labaKotor))}
                    ${card('Pengeluaran operasional', rp(L.opex))}${card(L.hangus ? 'DP batal hangus (' + L.batal.length + ')' : 'DP batal (' + L.batal.length + ') – refund', L.hangus ? '+ ' + rp(L.pendLain) : rp(L.dpBatal) + '<br><small>tidak masuk laba</small>')}
                    ${card('LABA BERSIH', rp(L.labaBersih), true)}${card('Pembelian stok (info)', rp(L.stok) + '<br><small>sudah terhitung di modal nota</small>')}
                    ${card('Piutang pelanggan (' + L.piutang.length + ')', rp(L.piutangTotal) + '<br><small>sudah masuk omzet, belum dibayar · semua periode</small>')}
                </div>
                <div style="margin-top:8px;"><label style="font-size:12px; opacity:.8;">DP servis yang dibatalkan:</label>
                    <select onchange="app.setDpBatalMode(this.value)"><option value="refund"${L.hangus ? '' : ' selected'}>Dikembalikan ke pelanggan (refund)</option><option value="hangus"${L.hangus ? ' selected' : ''}>Hangus (jadi pendapatan toko)</option></select></div>

                ${sec('Arus Kas (menurut tanggal uang diterima/dikeluarkan)')}
                <div style="display:flex; flex-wrap:wrap; gap:8px;">${card('Kas masuk', rp(L.masuk))}${card('Kas keluar', rp(L.keluar))}${card('Saldo periode', rp(L.saldo), true)}</div>
                ${tableWrap(`<thead><tr><th style="text-align:left;">Metode</th><th>Masuk</th><th>Keluar</th><th>Saldo</th></tr></thead><tbody>${rowsMetode}</tbody>`)}
                <small style="display:block; opacity:.7;">DP dianggap dibayar dengan metode yang sama seperti pelunasan. Cocokkan saldo Tunai dengan uang di laci, Transfer/QRIS dengan rekening.</small>

                ${sec('Piutang / Servis Berjalan (' + L.proses.length + ')')}
                <div style="display:flex; flex-wrap:wrap; gap:8px;">${card('Pembayaran diterima', rp(L.dpProses))}${card('Sisa tagihan', rp(L.sisaProses))}</div>
                ${L.proses.length ? tableWrap(`<thead><tr><th style="text-align:left;">Servis</th><th>Total</th><th>DP</th><th>Sisa</th></tr></thead><tbody>${rowsProses}</tbody>`) : ''}

                ${sec('Catat Pengeluaran')}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <input type="date" id="expTgl" value="${dKey(new Date())}">
                    <select id="expKat">${KAT_OPERASIONAL.concat([KAT_STOK]).map(k => `<option value="${k}">${k}</option>`).join('')}</select>
                    <input type="text" id="expKet" placeholder="Keterangan (opsional)">
                    <input type="number" id="expJumlah" inputmode="numeric" min="0" placeholder="Jumlah (Rp)">
                </div>
                <select id="expMetode" style="margin-top:8px;">${METODE_LIST.map(m => `<option value="${m}">Dibayar: ${m}</option>`).join('')}</select>
                <button class="btn-secondary" onclick="app.tambahPengeluaran()">➕ Simpan Pengeluaran</button>
                ${sec('Daftar Pengeluaran Periode Ini')}
                ${tableWrap(`<thead><tr><th style="text-align:left;">Pengeluaran</th><th>Jumlah</th><th></th></tr></thead><tbody>${rowsExp}</tbody>`)}
                ${rowsKat ? tableWrap(`<tbody>${rowsKat}</tbody>`) : ''}

                ${sec('Rincian Transaksi Selesai')}
                ${tableWrap(`<thead><tr><th style="text-align:left;">Servis</th><th>Total</th><th>Modal</th><th>Laba</th></tr></thead><tbody>${rowsSelesai}</tbody>`)}
                <small style="display:block; margin-top:8px; opacity:.7;">Omzet = transaksi yang sudah diambil/lunas pada periode tsb (1 servis dihitung 1x). Laba bersih = laba kotor − pengeluaran operasional (+ DP batal jika hangus). "Beli Stok/Sparepart" hanya masuk arus kas, tidak mengurangi laba karena modalnya sudah dicatat di nota.</small>
                <button class="btn-secondary" onclick="app.exportLaporanPDF()">📄 Laporan PDF (periode ini)</button>
                <button class="btn-secondary" onclick="app.exportBukuKas()">📒 Export Buku Kas CSV (periode ini)</button>
                <button class="btn-secondary" onclick="app.exportLaporanCSV()">📊 Export CSV per servis (semua)</button></div>`;
        }

        async function tambahPengeluaran() {
            const g = id => document.getElementById(id);
            const tanggal = g('expTgl').value, jumlah = Math.round(parseFloat(g('expJumlah').value) || 0);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) { showToast('Isi tanggal pengeluaran'); return; }
            if (jumlah <= 0) { showToast('Isi jumlah pengeluaran'); return; }
            const x = sanitizeExpense({ id: 'exp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), tanggal, kategori: g('expKat').value, ket: g('expKet').value.trim(), jumlah, metode: g('expMetode').value });
            try {
                await saveExpense(x); expenseData.push(x); try { await auditLog('Tambah pengeluaran',`${x.tanggal} ${x.kategori} ${rupiah(x.jumlah)} ${x.metode}`); } catch (_) {}
                showToast(inP(tanggal) ? 'Pengeluaran tersimpan' : 'Tersimpan (di luar periode yang sedang ditampilkan)');
                renderLaporan();
            } catch (e) { showToast('Gagal menyimpan pengeluaran'); }
        }
        async function hapusPengeluaran(id) {
            if (!confirm('Hapus pengeluaran ini?')) return;
            try { const old=expenseData.find(x=>x.id===id); await deleteExpenseDB(id); expenseData = expenseData.filter(x => x.id !== id); try { await auditLog('Hapus pengeluaran',`${old?.tanggal||''} ${old?.kategori||''} ${rupiah(old?.jumlah||0)}; ID ${id}`); } catch (_) {} renderLaporan(); showToast('Pengeluaran dihapus; jejak audit disimpan'); }
            catch (e) { showToast('Gagal menghapus'); }
        }

        // ---- MODUL LANJUTAN TAHAP 1-3 ----
        async function getAllStoreRaw(name) { if (!db) await initDB(); return new Promise((res, rej) => { const tx=db.transaction([name],'readonly'); const req=tx.objectStore(name).getAll(); req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); }); }
        async function getAllStore(name) { return decryptList(await getAllStoreRaw(name)); }
        async function putStore(name, item) {
            if (!db) await initDB();
            const toStore = await maybeEncryptForStore(item);
            return new Promise((res, rej) => { const tx=db.transaction([name],'readwrite'); tx.objectStore(name).put(toStore); tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); tx.onabort=()=>rej(tx.error); });
        }
        function validPayment(x) { return !!(x && x.id && x.serviceId && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && Number(x.amount)>0 && ['Tunai','Transfer','QRIS','Lain-lain'].includes(x.method) && ['masuk','refund'].includes(x.kind)); }
        function validInventory(x) { return !!(x && x.id && String(x.name||'').trim() && Number(x.qty)>=0 && Number(x.cost)>=0); }
        function rupiah(n) { return 'Rp ' + Math.round(Number(n)||0).toLocaleString('id-ID'); }
        async function auditLog(action, detail) { const row={id:'aud_'+Date.now()+'_'+Math.random().toString(36).slice(2,7), at:new Date().toISOString(), action:String(action), detail:String(detail||'').slice(0,500)}; await putStore('audit',row); auditData.unshift(row); }
        function allPaymentsFor(serviceId) { return paymentData.filter(p=>p.serviceId===serviceId); }
        async function showAdvancedFinance() { const box=document.getElementById('advancedFinanceBox'); if(!box) return; await loadHistory(); box.style.display=box.style.display==='block'?'none':'block'; if(box.style.display==='block') renderAdvancedFinance(); }
        function renderAdvancedFinance() {
            const box=document.getElementById('advancedFinanceBox'); if(!box) return;
            const today=dKey(new Date()), groups=groupServis();
            const uncollected=groups.filter(s=>s.status==='proses' && s.jenis==='servis');
            const overdue=uncollected.filter(s=>Math.floor((Date.now()-new Date(s.ts).getTime())/86400000)>=3);
            const stockValue=inventoryData.reduce((a,x)=>a+(Number(x.qty)||0)*(Number(x.cost)||0),0);
            const period=paymentData.filter(p=>p.date.startsWith(ymKey(new Date())) && p.kind==='masuk').reduce((a,p)=>a+p.amount,0);
            const rows=paymentData.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,25).map(p=>`<tr><td>${escapeHtml(p.date)}<br><small>${escapeHtml(p.serviceId)}</small></td><td>${escapeHtml(p.kind==='refund'?'Refund':'Pembayaran')}<br><small>${escapeHtml(p.method)}</small></td><td>${rupiah(p.amount)}</td><td><button class="btn-icon" onclick="app.reversePayment('${p.id}')" title="Koreksi dengan pembatalan">↩️</button></td></tr>`).join('')||'<tr><td colspan="4">Belum ada pembayaran manual</td></tr>';
            const pendingRows=uncollected.map(s=>`<tr><td>${escapeHtml(s.id)}<br>${escapeHtml(s.nama)}</td><td>${escapeHtml(s.device)}</td><td>${Math.max(0,Math.floor((Date.now()-new Date(s.ts).getTime())/86400000))} hari</td><td>${rupiah(Math.max(0,s.total-paidSoFar(s, paymentData)))}</td></tr>`).join('')||'<tr><td colspan="4">Tidak ada servis berjalan dari data yang terkelompok.</td></tr>';
            const piutangRows=groups.filter(s=>piutangOf(s,paymentData)>0).map(s=>`<tr><td>${escapeHtml(s.id)}<br><small>${escapeHtml(s.nama)}</small></td><td>${escapeHtml(s.device)}</td><td>${rupiah(piutangOf(s,paymentData))}</td></tr>`).join('')||'<tr><td colspan="3">Tidak ada piutang pelanggan.</td></tr>';
            const auditRows=auditData.slice().sort((a,b)=>b.at.localeCompare(a.at)).slice(0,10).map(a=>`<tr><td>${escapeHtml(new Date(a.at).toLocaleString('id-ID'))}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.detail)}</td></tr>`).join('')||'<tr><td colspan="3">Belum ada log koreksi.</td></tr>';
            const cloud=JSON.parse(localStorage.getItem('nota_cloud_config')||'{}');
            box.innerHTML=`<div style="border:1px solid #ddd;border-radius:12px;padding:12px;display:grid;gap:14px;">
            <div style="display:flex;justify-content:space-between;align-items:center"><b>🧾 Keuangan Lanjutan</b><button class="btn-icon" onclick="app.showAdvancedFinance()">✕</button></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="stat-card"><div class="stat-value">${rupiah(period)}</div><div class="stat-label">Pembayaran manual bulan ini</div></div><div class="stat-card"><div class="stat-value">${rupiah(stockValue)}</div><div class="stat-label">Nilai stok tercatat</div></div></div>
            <section><b>Tahap 1 — Buku Pembayaran</b><p style="font-size:12px">Pembayaran di sini <b>tambahan</b> di luar DP &amp; pelunasan yang sudah tercatat di nota (contoh: pelanggan melunasi kurang bayar, refund, koreksi). Jangan masukkan ulang DP/pelunasan yang sudah ada di nota agar kas tidak ganda. Masukkan ID servis yang sama persis seperti di riwayat/nota.</p>
            <div style="overflow:auto"><b>Piutang pelanggan (kurang bayar saat diambil)</b><table style="width:100%;font-size:12px"><thead><tr><th>ID/Pelanggan</th><th>Perangkat</th><th>Sisa utang</th></tr></thead><tbody>${piutangRows}</tbody></table></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><input id="payDate" type="date" value="${today}"><input id="payService" placeholder="ID servis / nota"><input id="payAmount" type="number" min="1" placeholder="Nominal (Rp)"><select id="payKind"><option value="masuk">Uang masuk</option><option value="refund">Refund keluar</option></select><select id="payMethod"><option>Tunai</option><option>Transfer</option><option>QRIS</option><option>Lain-lain</option></select><input id="payNote" placeholder="Catatan"></div><button class="btn-primary" onclick="app.addPayment()">Simpan pembayaran</button>
            <div style="overflow:auto"><table style="width:100%;font-size:12px"><thead><tr><th>Tanggal/ID</th><th>Jenis/Metode</th><th>Nominal</th><th>Koreksi</th></tr></thead><tbody>${rows}</tbody></table></div></section>
            <section><b>Saldo awal & kas</b><p style="font-size:12px">Saldo awal disimpan per metode; angka ini dipakai untuk dashboard saldo, bukan mengubah laporan historis.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><label>Tunai<input id="openCash" type="number" min="0" value="${Number(localStorage.getItem('opening_cash')||0)}"></label><label>Transfer<input id="openTransfer" type="number" min="0" value="${Number(localStorage.getItem('opening_transfer')||0)}"></label><label>QRIS<input id="openQris" type="number" min="0" value="${Number(localStorage.getItem('opening_qris')||0)}"></label><label>Lain-lain<input id="openOther" type="number" min="0" value="${Number(localStorage.getItem('opening_other')||0)}"></label></div><button class="btn-secondary" onclick="app.saveOpeningBalances()">Simpan saldo awal</button><p><b>Saldo awal total: ${rupiah(['opening_cash','opening_transfer','opening_qris','opening_other'].reduce((a,k)=>a+Number(localStorage.getItem(k)||0),0))}</b></p></section>
            <section><b>Tahap 2 — Stok sparepart</b><p style="font-size:12px">Stok kini dikelola di menu lengkap <b>📦 Manajemen Sparepart</b>: kartu stok, barang masuk, opname, stok minimum, dan pemotongan otomatis dari nota.</p><button class="btn-primary" onclick="app.spOpen()">📦 Buka Manajemen Sparepart</button></section>
            <section><b>Tahap 3 — Pengingat servis & analitik</b><p>Servis belum diambil/berjalan: <b>${uncollected.length}</b> · Lebih dari 3 hari: <b>${overdue.length}</b> · Pembayaran manual bulan ini: <b>${rupiah(period)}</b></p><div style="overflow:auto"><table style="width:100%;font-size:12px"><thead><tr><th>Nota/Pelanggan</th><th>Perangkat</th><th>Umur</th><th>Sisa estimasi</th></tr></thead><tbody>${pendingRows}</tbody></table></div><button class="btn-secondary" onclick="app.exportAdvancedBackup()">📦 Backup lengkap (nota+keuangan+stok+log)</button><button class="btn-secondary" onclick="app.importMergeBundle()">↔️ Impor / gabung data perangkat lain</button><button class="btn-secondary" onclick="app.configureCloudSync()">☁️ Konfigurasi cloud (persiapan)</button><p style="font-size:12px">Cloud ${cloud.url&&cloud.key?'URL/key tersimpan pada perangkat ini':'belum dikonfigurasi'}. Sinkronisasi otomatis belum aktif sampai backend/API aman dibuat dan diuji; tombol impor/gabung backup dapat dipakai untuk pemindahan data manual antar-HP. Jangan masukkan service-role key.</p></section>
            <section><b>Audit perubahan</b><div style="overflow:auto"><table style="width:100%;font-size:12px"><thead><tr><th>Waktu</th><th>Aksi</th><th>Detail</th></tr></thead><tbody>${auditRows}</tbody></table></div></section>
            </div>`;
        }
        async function addPayment() { const g=id=>document.getElementById(id), amount=Math.round(Number(g('payAmount').value)||0), serviceId=g('payService').value.trim(), date=g('payDate').value, kind=g('payKind').value, method=g('payMethod').value; if(!serviceId||amount<=0||!/^\d{4}-\d{2}-\d{2}$/.test(date)){showToast('Isi ID servis, tanggal, dan nominal yang valid');return;} const p={id:'pay_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),serviceId,date,amount,kind,method,note:g('payNote').value.trim(),createdAt:new Date().toISOString()}; if(!validPayment(p)){showToast('Data pembayaran tidak valid');return;} await putStore('pembayaran',p); paymentData.push(p); await auditLog('Tambah pembayaran',`${serviceId} ${kind} ${rupiah(amount)} ${method}`); renderAdvancedFinance(); showToast('Pembayaran tersimpan'); }
        async function reversePayment(id) { const p=paymentData.find(x=>x.id===id); if(!p||p.reversedBy||!confirm('Buat transaksi pembalik untuk mengoreksi pembayaran ini? Transaksi asli akan tetap tersimpan sebagai jejak audit.'))return; const rev={id:'payrev_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),serviceId:p.serviceId,date:dKey(new Date()),amount:p.amount,kind:p.kind==='masuk'?'refund':'masuk',method:p.method,note:'Koreksi transaksi '+p.id,createdAt:new Date().toISOString(),reversalOf:p.id}; p.reversedBy=rev.id; await putStore('pembayaran',p); await putStore('pembayaran',rev); paymentData.push(rev); await auditLog('Koreksi pembayaran',`${p.id} dibalik oleh ${rev.id}; ${rupiah(p.amount)}`); showToast('Transaksi pembalik dibuat; riwayat asli dipertahankan.'); renderAdvancedFinance(); }
        async function saveOpeningBalances() { const keys=['opening_cash','opening_transfer','opening_qris','opening_other'], ids=['openCash','openTransfer','openQris','openOther']; keys.forEach((k,i)=>localStorage.setItem(k,String(Math.max(0,Math.round(Number(document.getElementById(ids[i]).value)||0))))); await auditLog('Ubah saldo awal',keys.map(k=>k+'='+localStorage.getItem(k)).join('; ')); showToast('Saldo awal disimpan'); renderAdvancedFinance(); }
        async function exportAdvancedBackup() {
            await loadHistory();
            if (isEncryptionEnabled() && !cryptoKey) { showToast('Buka kunci PIN dulu sebelum backup'); showPinLock('unlock'); return; }
            const data = { version: 3, settings: tokoSettings, history: historyData.map(({ passwordDevice, ...n }) => n), logo: logoData, qris: qrisData, pengeluaran: expenseData, pembayaran: paymentData, inventori: inventoryData, stokmutasi: stockMoves, audit: auditData, footers, sk: skText, autoWASelesai, autoWAAmbil, waNotifTemplate, openingBalances: { cash: Number(localStorage.getItem('opening_cash') || 0), transfer: Number(localStorage.getItem('opening_transfer') || 0), qris: Number(localStorage.getItem('opening_qris') || 0), other: Number(localStorage.getItem('opening_other') || 0) }, exported: new Date().toISOString(), note: 'Data pola/password perangkat tidak disertakan.' };
            let json = JSON.stringify(data, null, 2);
            let fname = `Backup_Lengkap_${todayFile()}.json`;
            if (isEncryptionEnabled() && cryptoKey) {
                const enc = await encryptBackupPayload(json, cryptoKey);
                json = JSON.stringify(enc, null, 2);
                fname = `Backup_Encrypted_${todayFile()}.json`;
            }
            await kirimFile(fname, json, 'application/json', 'Backup Lengkap Nota Service');
            localStorage.setItem('last_backup_at', new Date().toISOString());
        }
        function todayFile(){return new Date().toISOString().slice(0,10)}
        async function importMergeBundle(){ const input=document.createElement('input'); input.type='file'; input.accept='.json,application/json'; input.onchange=async()=>{const f=input.files&&input.files[0];if(!f)return;try{const d=JSON.parse(await f.text());if(!d||!Array.isArray(d.history))throw new Error('Format backup tidak dikenal');if(!confirm('Gabungkan backup ke data lokal? Data dengan ID sama akan diperbarui. Buat backup dulu disarankan.'))return;let n=0;for(const raw of d.history){const x=sanitizeNota(raw);if(x){await saveToDB(x);n++;}}for(const x of (d.pengeluaran||[]))if(sanitizeExpense(x))await saveExpense(sanitizeExpense(x));for(const x of (d.pembayaran||[]))if(validPayment(x))await putStore('pembayaran',x);for(const x of (d.inventori||[]))if(validInventory(x))await putStore('inventori',x);for(const x of (d.stokmutasi||[]))if(validMove(x))await putStore('stokmutasi',x);for(const x of (d.audit||[]))if(x&&x.id&&x.action)await putStore('audit',x);await auditLog('Gabung backup',`${n} nota diimpor`);await loadHistory();renderAdvancedFinance();showToast(`Gabung selesai: ${n} nota`);}catch(e){showToast('Impor gagal: '+e.message)}};input.click(); }
        async function configureCloudSync(){const old=JSON.parse(localStorage.getItem('nota_cloud_config')||'{}');const url=prompt('Supabase Project URL (contoh https://xxxx.supabase.co). Kosongkan untuk membatalkan.',old.url||'');if(!url)return;const key=prompt('Supabase anon/publishable key (JANGAN gunakan service_role key).',old.key||'');if(!key)return;localStorage.setItem('nota_cloud_config',JSON.stringify({url:url.replace(/\/$/,''),key,configuredAt:new Date().toISOString()}));await auditLog('Konfigurasi cloud','URL disimpan lokal; key anon disimpan lokal pada perangkat ini');renderAdvancedFinance();showToast('Konfigurasi disimpan. Backend/tabel SQL masih harus disiapkan sebelum sinkronisasi aktif.');}

        // ---- Ekspor ----
        async function kirimFile(name, text, mime, title) {
            if (isCapacitor()) { await shareFile(name, textToB64(text), mime, title); return; }
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8;' })); a.download = name; a.click();
        }
        function exportLaporanCSV() {
            const data = groupServis(); if (!data.length) { showToast('Belum ada data'); return; }
            let csv = '\ufeffIDServis,Tanggal,Nama,Device,Status,Total,DP,Sisa,Modal,Laba,Metode,Jenis,KurangBayar,Piutang\n';
            data.forEach(s => { csv += [csvCell(s.id), csvCell(dKey(s.ts)), csvCell(s.nama), csvCell(s.device), csvCell(s.status), s.total, s.dpAmt, Math.max(s.total - s.dpAmt, 0), s.modal, s.status === 'diambil' ? s.total - s.modal : 0, csvCell(s.metode), csvCell(s.jenis), s.kurang, piutangOf(s, paymentData)].join(',') + '\n'; });
            kirimFile(`Laporan_Servis_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv', 'Laporan Servis').catch(e => showToast('Gagal: ' + e.message));
        }
        function exportBukuKas() {
            const L = hitungLaporan(); if (!L.kas.length) { showToast('Tidak ada transaksi kas di periode ini'); return; }
            let saldo = 0, csv = '\ufeffTanggal,Jenis,Keterangan,Masuk,Keluar,Saldo,Metode\n';
            L.kas.forEach(e => { saldo += e.masuk - e.keluar; csv += [csvCell(e.tgl), csvCell(e.jenis), csvCell(e.ket), e.masuk, e.keluar, saldo, csvCell(e.metode)].join(',') + '\n'; });
            csv += [csvCell(''), csvCell('TOTAL'), csvCell(''), L.masuk, L.keluar, L.saldo, csvCell('')].join(',') + '\n';
            kirimFile(`BukuKas_${lapMode}_${lapVal}.csv`, csv, 'text/csv', 'Buku Kas ' + lapVal).catch(e => showToast('Gagal: ' + e.message));
        }
        async function exportLaporanPDF() {
            try {
                const L = hitungLaporan(), { jsPDF } = window.jspdf, doc = new jsPDF('p', 'mm', 'a4');
                const clean = t => String(t ?? '').replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '');
                let y = 16;
                const need = () => { if (y > 280) { doc.addPage(); y = 16; } };
                const head = t => { need(); y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(clean(t), 14, y); y += 6; doc.setFontSize(10); };
                const row = (a, b, bold) => { need(); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(clean(a).slice(0, 75), 14, y); if (b !== undefined) doc.text(clean(b), 196, y, { align: 'right' }); y += 5.5; };
                doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(clean(tokoSettings.nama || 'Service HP'), 14, y); y += 7;
                doc.setFontSize(11); doc.text('Laporan Keuangan ' + lapMode + ': ' + lapVal, 14, y); y += 5; doc.setFontSize(10);
                head('Laba / Rugi');
                row('Omzet (' + L.selesai.length + ' transaksi)', rp(L.omzet)); row('Modal sparepart/barang', rp(L.modal)); row('Laba kotor', rp(L.labaKotor), true);
                row('Pengeluaran operasional', '-' + rp(L.opex).replace('-', ''));
                if (L.hangus) row('DP batal hangus (' + L.batal.length + ')', rp(L.pendLain));
                row('LABA BERSIH', rp(L.labaBersih), true);
                head('Arus Kas');
                METODE_LIST.forEach(m => row(m + '  (masuk ' + formatRupiah(L.metode[m].masuk) + ' / keluar ' + formatRupiah(L.metode[m].keluar) + ')', rp(L.metode[m].masuk - L.metode[m].keluar)));
                row('Total kas masuk', rp(L.masuk)); row('Total kas keluar', rp(L.keluar)); row('Saldo periode', rp(L.saldo), true);
                head('Piutang / servis berjalan (' + L.proses.length + ')');
                row('DP sudah diterima', rp(L.dpProses)); row('Sisa tagihan', rp(L.sisaProses));
                head('Pengeluaran (' + L.exps.length + ')');
                L.exps.forEach(x => row(x.tanggal + '  ' + x.kategori + (x.ket ? ': ' + x.ket : ''), rp(x.jumlah)));
                if (!L.exps.length) row('-');
                head('Transaksi selesai (' + L.selesai.length + ')');
                L.selesai.forEach(s => row(dKey(s.ts) + '  ' + s.nama + ' - ' + s.device + ' [' + s.metode + ']', rp(s.total)));
                if (!L.selesai.length) row('-');
                const name = `Laporan_${lapMode}_${lapVal}.pdf`;
                if (isCapacitor()) await shareFile(name, doc.output('datauristring').split(',')[1], 'application/pdf', 'Laporan ' + lapVal); else doc.save(name);
                showToast('✅ PDF laporan siap');
            } catch (e) { showToast('Gagal PDF: ' + e.message); }
        }

        // ============================================
        // MANAJEMEN SPAREPART (v15)
        // Master barang, kartu stok (mutasi), barang masuk, opname,
        // dan pemotongan stok otomatis dari nota Selesai / Langsung / Penjualan.
        // ============================================
        const SP_KATEGORI = ['LCD / Layar', 'Baterai', 'Konektor / Flexibel', 'IC / Chip', 'Casing / Housing', 'Kamera', 'Speaker / Mic', 'Charger / Kabel', 'Aksesoris', 'Lain-lain'];
        const SP_TIPE = { awal: 'Stok awal', masuk: 'Barang masuk', keluar: 'Dipakai nota', koreksi: 'Penyesuaian' };
        let spFilter = 'all', spQuery = '', spAutoText = '';

        function validMove(x) { return !!(x && x.id && x.itemId && x.at && Number.isFinite(Number(x.qty)) && Number.isFinite(Number(x.balance))); }
        function spInt(v) { return Math.max(0, Math.round(Number(v) || 0)); }
        function spById(id) { return inventoryData.find(x => x.id === id); }
        function spActive() { return inventoryData.filter(x => !x.archived); }
        function spStatus(x) { const q = Number(x.qty) || 0, m = Number(x.minQty) || 0; if (q <= 0) return 'habis'; if (m > 0 && q <= m) return 'menipis'; return 'ok'; }
        function spBadge(x) { const s = spStatus(x); if (s === 'habis') return '<span class="sp-badge sp-habis">HABIS</span>'; if (s === 'menipis') return '<span class="sp-badge sp-tipis">MENIPIS</span>'; return ''; }

        // Satu-satunya jalan mengubah stok: memperbarui item + menulis baris kartu stok.
        async function spMove(item, delta, type, o = {}) {
            const newQty = (Number(item.qty) || 0) + delta;
            if (newQty < 0) throw new Error('Stok tidak boleh negatif');
            const now = new Date().toISOString();
            item.qty = newQty; item.updatedAt = now;
            if (o.setCost !== undefined) item.cost = o.setCost;
            const mv = { id: 'mv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), itemId: item.id, itemName: item.name, at: now, type, qty: delta, balance: newQty, cost: Number(o.unitCost !== undefined ? o.unitCost : item.cost) || 0, ref: o.ref || '', note: String(o.note || '').slice(0, 200) };
            await putStore('inventori', item);
            await putStore('stokmutasi', mv);
            stockMoves.push(mv);
            if (!inventoryData.some(y => y.id === item.id)) inventoryData.push(item);
            return mv;
        }

        // ---- Kebutuhan stok dari sebuah nota (fungsi murni) ----
        function spNeedsFromNota(n) {
            if (!n) return [];
            if (n.type === 'jual') return ((n.jual && n.jual.items) || []).filter(i => i.itemId).map(i => ({ itemId: i.itemId, qty: Math.max(1, Number(i.qty) || 1) }));
            if (n.type === 'selesai' || n.type === 'langsung') return (n.partsUsed || []).filter(p => p.itemId).map(p => ({ itemId: p.itemId, qty: Math.max(1, Number(p.qty) || 1) }));
            return [];
        }
        function spShortages(needs, extra) {
            const agg = {}; needs.forEach(r => { agg[r.itemId] = (agg[r.itemId] || 0) + r.qty; });
            const out = [];
            for (const id in agg) { const it = spById(id); if (!it || it.archived) continue; const avail = (Number(it.qty) || 0) + ((extra && extra[id]) || 0); if (agg[id] > avail) out.push({ item: it, need: agg[id], avail }); }
            return out;
        }
        function spPendingRestore(notaId) {
            const map = {}; if (!notaId) return map;
            stockMoves.filter(m => m.ref === notaId && m.type === 'keluar' && !m.reversed).forEach(m => { map[m.itemId] = (map[m.itemId] || 0) - m.qty; });
            return map;
        }
        async function spPreflight() {
            const needs = currentType === 'jual' ? bacaItemJual().filter(i => i.itemId).map(i => ({ itemId: i.itemId, qty: i.qty })) : (currentType === 'selesai' || currentType === 'langsung') ? bacaPartsUsed().map(p => ({ itemId: p.itemId, qty: p.qty })) : [];
            if (!needs.length) return true;
            const sh = spShortages(needs, spPendingRestore(window._spEditFrom));
            if (!sh.length) return true;
            return confirm('Stok tidak cukup:\n' + sh.map(s => `• ${s.item.name}: butuh ${s.need}, stok ${s.avail}`).join('\n') + '\n\nLanjutkan? Stok hanya dikurangi sampai 0.');
        }
        async function spConsumeForNota(n) {
            let used = 0;
            for (const r of spNeedsFromNota(n)) {
                const item = spById(r.itemId); if (!item || item.archived) continue;
                if (stockMoves.some(m => m.ref === n.id && m.itemId === item.id && m.type === 'keluar' && !m.reversed)) continue;
                const take = Math.min(r.qty, Number(item.qty) || 0);
                if (take <= 0) { try { await auditLog('Stok kurang', `${item.name}: nota ${n.notaId || n.id} butuh ${r.qty}, stok 0`); } catch (_) {} continue; }
                await spMove(item, -take, 'keluar', { ref: n.id, note: `Nota ${n.notaId || n.id} · ${unesc(n.nama || '')}` + (take < r.qty ? ` (kurang ${r.qty - take})` : '') });
                used++;
            }
            if (used) { try { await auditLog('Stok dipakai nota', `${n.notaId || n.id}: ${used} jenis sparepart`); } catch (_) {} }
        }
        async function spRestoreForNota(notaId) {
            for (const m of stockMoves.filter(x => x.ref === notaId && x.type === 'keluar' && !x.reversed)) {
                const item = spById(m.itemId);
                if (item) await spMove(item, -m.qty, 'koreksi', { ref: notaId, note: 'Nota diedit ulang: stok dikembalikan' });
                m.reversed = true; await putStore('stokmutasi', m);
            }
        }


        // Servis dibatalkan: tawarkan pengembalian sparepart yang sudah terpotong pada rangkaian nota yang sama
        async function spReturnForChain(n) {
            const chain = new Set(historyData.filter(h => (h.originalId || h.id) === (n.originalId || n.id)).map(h => h.id));
            const ms = stockMoves.filter(m => m.type === 'keluar' && !m.reversed && chain.has(m.ref));
            if (!ms.length) return;
            const list = ms.map(m => `• ${m.itemName}: ${-m.qty}`).join('\n');
            if (!confirm('Servis dibatalkan. Kembalikan sparepart ini ke stok?\n' + list + '\n\nPilih Batal jika sparepart sudah terpasang/tidak bisa dipakai lagi.')) return;
            for (const m of ms) {
                const item = spById(m.itemId);
                if (item) await spMove(item, -m.qty, 'koreksi', { ref: m.ref, note: `Servis dibatalkan (nota ${n.notaId || n.id}): stok dikembalikan` });
                m.reversed = true; await putStore('stokmutasi', m);
            }
            try { await auditLog('Stok dikembalikan', `Servis batal ${n.notaId || n.id}: ${ms.length} mutasi`); } catch (_) {}
        }

        // ---- Pemilih sparepart di form nota ----
        function spPartOptions(sel, q) {
            const k = String(q || '').trim().toLowerCase();
            return '<option value="">— pilih sparepart —</option>' + spActive().filter(x => x.id === sel || !k || [x.name, x.sku, x.compat, x.category].some(v => String(v || '').toLowerCase().includes(k))).sort((a, b) => a.name.localeCompare(b.name)).map(x => `<option value="${escapeHtml(x.id)}"${x.id === sel ? ' selected' : ''}>${escapeHtml(x.name)}${x.sku ? ' (' + escapeHtml(x.sku) + ')' : ''} · stok ${x.qty}</option>`).join('');
        }
        function spAddPartRow(itemId, qty) {
            const d = document.createElement('div'); d.className = 'part-row'; d.style.cssText = 'display:grid; grid-template-columns:3fr 1fr auto; gap:6px; margin-bottom:6px; align-items:center;';
            d.innerHTML = `<input type="search" class="p-cari" placeholder="🔎 Cari sparepart / model..." oninput="app.spFilterSel(this)" style="grid-column:1 / -1;"><select class="p-item" onchange="app.spPartChanged()">${spPartOptions(itemId)}</select><input type="number" class="p-qty" min="1" value="${Math.max(1, Number(qty) || 1)}" oninput="app.spPartChanged()"><button type="button" onclick="this.closest('.part-row').remove(); app.spPartChanged()">✖</button>`;
            document.getElementById('partRows').appendChild(d);
        }
        function spFilterSel(inp) {
            const sel = inp.parentElement.querySelector('select'); if (!sel) return;
            const cur = sel.value; sel.innerHTML = spPartOptions(cur, inp.value);
            if (!cur && inp.value.trim() && sel.options.length === 2) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change')); }
        }
        function bacaPartsUsed() {
            return Array.from(document.querySelectorAll('#partRows .part-row')).map(r => { const it = spById(r.querySelector('.p-item').value); return it ? { itemId: it.id, name: it.name, qty: Math.max(1, parseInt(r.querySelector('.p-qty').value) || 1), cost: Number(it.cost) || 0, price: Number(it.price) || 0 } : null; }).filter(Boolean);
        }
        function spPartChanged() {
            const parts = bacaPartsUsed(), modal = parts.reduce((a, p) => a + p.qty * p.cost, 0), jual = parts.reduce((a, p) => a + p.qty * p.price, 0);
            const sum = document.getElementById('partSummary');
            if (sum) sum.textContent = parts.length ? `Modal sparepart: ${rupiah(modal)}` + (currentType === 'diagnosa' && jual > 0 ? ` · Harga jual: ${rupiah(jual)}` : '') : '';
            const names = parts.map(p => `${p.qty}x ${p.name}`).join(', ');
            if (currentType === 'selesai' || currentType === 'langsung') { if (parts.length) document.getElementById('modal').value = modal; }
            const fid = currentType === 'langsung' ? 'sparepartLangsung' : currentType === 'diagnosa' ? 'sparepart' : null, f = fid && document.getElementById(fid);
            if (f && parts.length && (!f.value || f.value === spAutoText)) f.value = names;
            if (parts.length) spAutoText = names;
            if (currentType === 'diagnosa' && parts.length && jual > 0) { document.getElementById('hargaSparepart').value = jual; hitungEstimasi(); }
        }
        function spShowPicker(type) {
            const box = document.getElementById('partPickerBox'); if (!box) return;
            const on = ['diagnosa', 'selesai', 'langsung'].includes(type); box.style.display = on ? 'block' : 'none';
            spAutoText = '';
            const note = document.getElementById('partPickerNote');
            if (note) note.textContent = type === 'diagnosa' ? '(estimasi saja — stok dipotong saat nota Selesai)' : '(stok otomatis dipotong saat nota disimpan)';
        }
        function spClearPicker() { const r = document.getElementById('partRows'); if (r) r.innerHTML = ''; const s = document.getElementById('partSummary'); if (s) s.textContent = ''; spAutoText = ''; }
        function spPrefillPlan(n, tipe) {
            if (tipe !== 'selesai' && tipe !== 'diagnosa') { spClearPicker(); return; }
            spClearPicker();
            if (n && n.partsPlan && n.partsPlan.length) { n.partsPlan.forEach(p => { if (spById(p.itemId)) spAddPartRow(p.itemId, p.qty); }); spPartChanged(); }
        }
        function spPickJual(sel) {
            const row = sel.closest('.jual-row'), it = spById(sel.value); if (!it) { hitungJual(); return; }
            row.querySelector('.j-nama').value = it.name; row.querySelector('.j-harga').value = it.price || ''; row.querySelector('.j-modal').value = it.cost || 0;
            hitungJual();
        }

        // ---- Layar Manajemen Sparepart ----
        async function spOpen() {
            await loadHistory();
            document.querySelectorAll('.form-card, .preview-card, .settings-card, .history-card').forEach(c => c.classList.remove('active'));
            document.getElementById('stokCard').classList.add('active');
            spRender();
        }
        function spRender() {
            const box = document.getElementById('stokBox'); if (!box) return;
            box.innerHTML = `<div id="spSummary"></div>
            <div style="display:grid; grid-template-columns:2fr 1fr; gap:6px; margin:10px 0;"><input id="spSearch" placeholder="Cari nama, SKU, model, rak..." value="${escapeHtml(spQuery)}" oninput="app.spSearch(this.value)"><select onchange="app.spSetFilter(this.value)">${[['all', 'Semua'], ['menipis', 'Menipis'], ['habis', 'Habis'], ['arsip', 'Arsip']].map(([v, t]) => `<option value="${v}"${spFilter === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;"><button class="btn-primary" onclick="app.spShowForm()">➕ Sparepart Baru</button><button class="btn-secondary" onclick="app.spExportCSV()">📊 Ekspor Stok CSV</button></div>
            <div id="spPanel" style="display:none; margin:10px 0;"></div><div id="spList" style="margin-top:10px;"></div>`;
            spRefresh();
        }
        function spRefresh() {
            const act = spActive(), nilai = act.reduce((a, x) => a + (Number(x.qty) || 0) * (Number(x.cost) || 0), 0), unit = act.reduce((a, x) => a + (Number(x.qty) || 0), 0);
            const tipis = act.filter(x => spStatus(x) === 'menipis').length, habis = act.filter(x => spStatus(x) === 'habis').length;
            const sm = document.getElementById('spSummary');
            if (sm) sm.innerHTML = `<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;"><div class="stat-card"><div class="stat-value">${act.length}</div><div class="stat-label">Jenis sparepart (${unit} unit)</div></div><div class="stat-card"><div class="stat-value" style="font-size:16px;">${rupiah(nilai)}</div><div class="stat-label">Nilai stok (modal)</div></div></div>` + ((tipis || habis) ? `<div class="sp-alert">⚠️ ${tipis ? tipis + ' menipis' : ''}${tipis && habis ? ' · ' : ''}${habis ? habis + ' habis' : ''} — perlu dibeli</div>` : '');
            const q = spQuery.trim().toLowerCase();
            let list = inventoryData.filter(x => spFilter === 'arsip' ? x.archived : !x.archived);
            if (spFilter === 'menipis') list = list.filter(x => spStatus(x) === 'menipis'); else if (spFilter === 'habis') list = list.filter(x => spStatus(x) === 'habis');
            if (q) list = list.filter(x => [x.name, x.sku, x.compat, x.category, x.supplier, x.location].some(v => String(v || '').toLowerCase().includes(q)));
            list.sort((a, b) => ({ habis: 0, menipis: 1, ok: 2 }[spStatus(a)] - { habis: 0, menipis: 1, ok: 2 }[spStatus(b)]) || a.name.localeCompare(b.name));
            const el = document.getElementById('spList'); if (!el) return;
            el.innerHTML = list.map(x => {
                const margin = x.price > 0 && x.cost > 0 ? Math.round((x.price - x.cost) / x.price * 100) : null;
                const meta = [x.sku, x.category, x.location ? 'Rak ' + x.location : '', x.compat ? 'Cocok: ' + x.compat : '', x.supplier ? 'Supplier: ' + x.supplier : ''].filter(Boolean).map(escapeHtml).join(' · ');
                const id = escapeHtml(x.id);
                return `<div class="sp-item"><div style="display:flex; justify-content:space-between; gap:8px;"><div><b>${escapeHtml(x.name)}</b> ${spBadge(x)}</div><div style="text-align:right; white-space:nowrap;"><b style="font-size:18px;">${x.qty}</b><br><small>min ${Number(x.minQty) || 0}</small></div></div>
                ${meta ? `<small style="display:block; opacity:.75;">${meta}</small>` : ''}
                <small style="display:block; margin-top:2px;">Modal ${rupiah(x.cost)}${x.price > 0 ? ' · Jual ' + rupiah(x.price) : ''}${margin !== null ? ' · Margin ' + margin + '%' : ''} · Nilai ${rupiah((x.qty || 0) * (x.cost || 0))}</small>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">${x.archived ? `<button class="btn-secondary sp-btn" onclick="app.spArchive('${id}')">♻️ Aktifkan</button>` : `<button class="btn-secondary sp-btn" onclick="app.spShowRestock('${id}')">➕ Masuk</button><button class="btn-secondary sp-btn" onclick="app.spShowAdjust('${id}')">± Opname</button>`}<button class="btn-secondary sp-btn" onclick="app.spShowLedger('${id}')">📜 Kartu</button>${x.archived ? '' : `<button class="btn-secondary sp-btn" onclick="app.spShowForm('${id}')">✏️ Edit</button><button class="btn-secondary sp-btn" onclick="app.spArchive('${id}')">🗑️</button>`}</div></div>`;
            }).join('') || `<div style="text-align:center; opacity:.7; padding:20px;">${inventoryData.length ? 'Tidak ada barang yang cocok.' : 'Belum ada sparepart. Tekan “Sparepart Baru” untuk mulai.'}</div>`;
        }
        function spSearch(v) { spQuery = v; spRefresh(); }
        function spSetFilter(v) { spFilter = v; spRefresh(); }
        function spPanel(html) { const p = document.getElementById('spPanel'); if (!p) return; p.innerHTML = `<div class="sp-panel">${html}</div>`; p.style.display = 'block'; p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        function spClosePanel() { const p = document.getElementById('spPanel'); if (p) { p.style.display = 'none'; p.innerHTML = ''; } }

        function spShowForm(id) {
            const x = id ? spById(id) : null, v = k => escapeHtml(x && x[k] !== undefined ? x[k] : '');
            spPanel(`<b>${x ? '✏️ Edit Sparepart' : '➕ Sparepart Baru'}</b>
            <input id="spName" placeholder="Nama (mis. LCD Samsung A12 Original)" value="${v('name')}">
            <div class="sp-grid"><input id="spSku" placeholder="SKU / kode" value="${v('sku')}"><select id="spKat">${SP_KATEGORI.map(k => `<option${x && x.category === k ? ' selected' : ''}>${k}</option>`).join('')}</select><input id="spLok" placeholder="Lokasi / rak" value="${v('location')}"><input id="spSup" placeholder="Supplier" value="${v('supplier')}"></div>
            <input id="spCompat" placeholder="Cocok untuk (mis. Samsung A12 / A02s / M12)" value="${v('compat')}">
            <div class="sp-grid">${x ? '' : '<label>Stok awal<input id="spQty" type="number" min="0" value="0"></label>'}<label>Stok minimum<input id="spMin" type="number" min="0" value="${x ? Number(x.minQty) || 0 : 1}"></label><label>Modal / unit (Rp)<input id="spCost" type="number" min="0" value="${x ? Number(x.cost) || 0 : ''}"></label><label>Harga jual / unit (Rp)<input id="spPrice" type="number" min="0" value="${x && x.price ? x.price : ''}"></label></div>
            ${x ? '<small>Untuk mengubah jumlah stok gunakan ➕ Masuk atau ± Opname agar tercatat di kartu stok.</small>' : ''}
            <div class="sp-grid"><button class="btn-primary" onclick="app.spSaveForm('${x ? escapeHtml(x.id) : ''}')">💾 Simpan</button><button class="btn-secondary" onclick="app.spClosePanel()">Batal</button></div>`);
        }
        async function spSaveForm(id) {
            const g = k => document.getElementById(k), name = g('spName').value.trim(), sku = g('spSku').value.trim();
            if (!name) { showToast('Nama sparepart wajib diisi'); return; }
            const dup = inventoryData.find(y => y.id !== id && ((sku && y.sku && y.sku.toLowerCase() === sku.toLowerCase()) || y.name.toLowerCase() === name.toLowerCase()));
            if (dup) { showToast(`"${dup.name}" sudah ada${dup.archived ? ' (di arsip)' : ''}. Gunakan ➕ Masuk untuk menambah stok.`); return; }
            const f = { name, sku, category: g('spKat').value, location: g('spLok').value.trim(), supplier: g('spSup').value.trim(), compat: g('spCompat').value.trim(), minQty: spInt(g('spMin').value), cost: spInt(g('spCost').value), price: spInt(g('spPrice').value) };
            try {
                if (id) {
                    const x = spById(id); if (!x) return; const oldCost = x.cost;
                    Object.assign(x, f, { updatedAt: new Date().toISOString() }); await putStore('inventori', x);
                    await auditLog('Edit sparepart', `${x.name}${oldCost !== x.cost ? `; modal ${rupiah(oldCost)} → ${rupiah(x.cost)}` : ''}`);
                } else {
                    const x = { id: 'stk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), qty: 0, archived: false, createdAt: new Date().toISOString(), ...f, updatedAt: new Date().toISOString() };
                    const q0 = spInt(g('spQty').value); await putStore('inventori', x); inventoryData.push(x);
                    if (q0 > 0) await spMove(x, q0, 'awal', { note: 'Stok awal' });
                    await auditLog('Sparepart baru', `${x.name}; stok awal ${q0}; modal ${rupiah(x.cost)}`);
                }
                spClosePanel(); spRefresh(); showToast('Sparepart tersimpan');
            } catch (e) { showToast('Gagal menyimpan: ' + e.message); }
        }
        function spShowRestock(id) {
            const x = spById(id); if (!x) return;
            spPanel(`<b>➕ Barang Masuk — ${escapeHtml(x.name)}</b><small style="display:block;">Stok sekarang ${x.qty} · modal rata-rata ${rupiah(x.cost)}</small>
            <div class="sp-grid"><label>Jumlah masuk<input id="rsQty" type="number" min="1" value="1"></label><label>Harga beli / unit (Rp)<input id="rsCost" type="number" min="0" value="${Number(x.cost) || ''}"></label></div>
            <input id="rsSup" placeholder="Supplier" value="${escapeHtml(x.supplier || '')}">
            <label style="display:flex; gap:8px; align-items:center; margin:8px 0;"><input type="checkbox" id="rsExp" checked style="width:auto;"> Catat juga sebagai pengeluaran “${KAT_STOK}” (masuk arus kas)</label>
            <select id="rsMetode">${METODE_LIST.map(m => `<option>${m}</option>`).join('')}</select>
            <small style="display:block; margin:6px 0;">Modal per unit dihitung ulang sebagai rata-rata tertimbang dari stok lama dan pembelian baru.</small>
            <div class="sp-grid"><button class="btn-primary" onclick="app.spSaveRestock('${escapeHtml(x.id)}')">💾 Simpan</button><button class="btn-secondary" onclick="app.spClosePanel()">Batal</button></div>`);
        }
        async function spSaveRestock(id) {
            const x = spById(id); if (!x) return; const g = k => document.getElementById(k);
            const qty = spInt(g('rsQty').value), cost = spInt(g('rsCost').value);
            if (qty <= 0) { showToast('Jumlah masuk harus lebih dari 0'); return; }
            const old = Number(x.qty) || 0, oc = Number(x.cost) || 0, avg = old + qty > 0 ? Math.round((old * oc + qty * cost) / (old + qty)) : cost, sup = g('rsSup').value.trim();
            try {
                if (sup) x.supplier = sup;
                await spMove(x, qty, 'masuk', { unitCost: cost, setCost: avg, note: `Beli ${qty} @ ${rupiah(cost)}${sup ? ' dari ' + sup : ''}` });
                if (g('rsExp').checked && qty * cost > 0) { const e = sanitizeExpense({ id: 'exp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), tanggal: dKey(new Date()), kategori: KAT_STOK, ket: `${x.name} x${qty}`, jumlah: qty * cost, metode: g('rsMetode').value }); if (e) { await saveExpense(e); expenseData.push(e); } }
                await auditLog('Barang masuk', `${x.name}: +${qty} @ ${rupiah(cost)}; modal rata-rata ${rupiah(avg)}`);
                spClosePanel(); spRefresh(); showToast('Stok bertambah');
            } catch (e) { showToast('Gagal: ' + e.message); }
        }
        function spShowAdjust(id) {
            const x = spById(id); if (!x) return;
            spPanel(`<b>± Opname — ${escapeHtml(x.name)}</b><small style="display:block;">Stok di sistem: ${x.qty}. Isi jumlah fisik yang sebenarnya.</small>
            <div class="sp-grid"><label>Stok fisik<input id="adQty" type="number" min="0" value="${x.qty}"></label><label>Alasan<select id="adWhy"><option>Hasil hitung fisik</option><option>Barang rusak</option><option>Barang hilang</option><option>Retur ke supplier</option><option>Lainnya</option></select></label></div>
            <input id="adNote" placeholder="Catatan (opsional)">
            <div class="sp-grid"><button class="btn-primary" onclick="app.spSaveAdjust('${escapeHtml(x.id)}')">💾 Simpan</button><button class="btn-secondary" onclick="app.spClosePanel()">Batal</button></div>`);
        }
        async function spSaveAdjust(id) {
            const x = spById(id); if (!x) return; const g = k => document.getElementById(k), actual = spInt(g('adQty').value), delta = actual - (Number(x.qty) || 0);
            if (delta === 0) { showToast('Tidak ada selisih'); return; }
            try {
                const note = g('adWhy').value + (g('adNote').value.trim() ? ': ' + g('adNote').value.trim() : '');
                await spMove(x, delta, 'koreksi', { note });
                await auditLog('Opname stok', `${x.name}: ${delta > 0 ? '+' : ''}${delta} → ${x.qty} (${note})`);
                spClosePanel(); spRefresh(); showToast('Stok disesuaikan');
            } catch (e) { showToast('Gagal: ' + e.message); }
        }
        function spShowLedger(id) {
            const x = spById(id); if (!x) return;
            const ms = stockMoves.filter(m => m.itemId === id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
            const rows = ms.map(m => `<tr><td>${escapeHtml(new Date(m.at).toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td><td>${escapeHtml(SP_TIPE[m.type] || m.type)}<br><small>${escapeHtml(m.note || '')}</small></td><td style="color:${m.qty < 0 ? '#c62828' : '#2e7d32'}; white-space:nowrap;"><b>${m.qty > 0 ? '+' : ''}${m.qty}</b></td><td>${m.balance}</td></tr>`).join('') || '<tr><td colspan="4">Belum ada mutasi.</td></tr>';
            spPanel(`<div style="display:flex; justify-content:space-between;"><b>📜 Kartu Stok — ${escapeHtml(x.name)}</b><button class="btn-icon" onclick="app.spClosePanel()">✕</button></div><div style="overflow:auto;"><table style="width:100%; font-size:12px;"><thead><tr><th>Waktu</th><th>Keterangan</th><th>Qty</th><th>Saldo</th></tr></thead><tbody>${rows}</tbody></table></div>`);
        }
        async function spArchive(id) {
            const x = spById(id); if (!x) return;
            if (x.archived) { x.archived = false; } else { if (!confirm(`Arsipkan "${x.name}"?${x.qty > 0 ? `\nStok ${x.qty} masih tercatat dan tidak dihitung di nilai stok.` : ''}\nRiwayat kartu stok tetap tersimpan, dan bisa diaktifkan lagi dari filter Arsip.`)) return; x.archived = true; }
            x.updatedAt = new Date().toISOString(); await putStore('inventori', x); await auditLog(x.archived ? 'Arsip sparepart' : 'Aktifkan sparepart', x.name); spRefresh();
        }
        async function spExportCSV() {
            if (!inventoryData.length) { showToast('Belum ada data stok'); return; }
            const head = ['SKU', 'Nama', 'Kategori', 'Cocok untuk', 'Lokasi', 'Supplier', 'Stok', 'Stok minimum', 'Modal/unit', 'Harga jual', 'Nilai stok', 'Status'];
            const rows = inventoryData.map(x => [x.sku, x.name, x.category, x.compat, x.location, x.supplier, x.qty, x.minQty || 0, x.cost || 0, x.price || 0, (x.qty || 0) * (x.cost || 0), x.archived ? 'Arsip' : spStatus(x)].map(csvCell).join(','));
            await kirimFile(`Stok_Sparepart_${todayFile()}.csv`, '\ufeff' + [head.map(csvCell).join(',')].concat(rows).join('\n'), 'text/csv', 'Stok Sparepart');
        }

        return { init, selectType, selectAmbilStatus, buatPreview, renderPreview, updateWorkflowButtons, lanjutKe, kirimWA, printBluetooth, printFromPreview, generatePDF, exportCSV, exportJSON, restoreData, clearAllData, showHistory, showSettings, saveSettings, handleLogo, removeLogo, handleQris, removeQris, toggleDarkMode, backToForm, buatNotaBaru, resetForm, importContact, handleFotoDevice, cleanPhoneInput, validatePhone, hitungSisa, loadHistoryItem, renderHistory, backupData: exportJSON, backupToDrive, previewThermal, closeThermalPreview, saveContact, savePrinterId, clearPrinterId, pickPrinter, testPrint, resetPattern, clearPattern, tambahItemJual, hitungJual, mulaiKlaim, klaimOff, cariGaransi, hitungEstimasi, showLaporan, renderLaporan, exportLaporanCSV, exportBukuKas, exportLaporanPDF, setLapMode, setLapVal, setDpBatalMode, tambahPengeluaran, hapusPengeluaran, showAdvancedFinance, addPayment, reversePayment, saveOpeningBalances, spOpen, spSearch, spSetFilter, spShowForm, spSaveForm, spShowRestock, spSaveRestock, spShowAdjust, spSaveAdjust, spShowLedger, spArchive, spExportCSV, spClosePanel, spAddPartRow, spPartChanged, spFilterSel, spPickJual, exportAdvancedBackup, importMergeBundle, configureCloudSync, showActivationDialog, closeActivation, doActivate, updateLicenseUI, showPinLock, closePinLock, submitPinLock, enableEncryptionFromSettings, changePinFromSettings, disableEncryption, updateCryptoUI };
    })();

    (async () => {
    window.app = app; // dipasang dulu agar tombol (onclick="app.xxx") tidak mati bila init bermasalah
    try { await app.init(); } catch (e) { console.error('Init gagal', e); try { const t = document.getElementById('toast'); t.textContent = '⚠️ Gagal memuat data: ' + ((e && e.message) || e); t.classList.add('show'); } catch (_) {} }
    try { const last=localStorage.getItem('last_backup_at'); const age=last?Date.now()-new Date(last).getTime():Infinity; if(age>7*86400000) setTimeout(()=>{ if(confirm('Pengingat backup: data belum di-backup selama 7 hari atau belum pernah. Buat backup lengkap sekarang?')) app.exportAdvancedBackup(); },1800); } catch(e) {}
    console.log('✅ Aplikasi Nota Service HP berhasil diinisialisasi');

    const fotoIn = document.getElementById('fotoDevice');
    if (fotoIn) fotoIn.addEventListener('click', e => { if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) { e.preventDefault(); app.handleFotoDevice(fotoIn); } });
    document.getElementById('historyList').addEventListener('click', e => { const it = e.target.closest('[data-id]'); if (it) app.loadHistoryItem(it.dataset.id); });
    const maskCb = document.getElementById('maskPwdCheckbox'); if (maskCb) maskCb.checked = localStorage.getItem('mask_pwd') === 'true';

    if ('serviceWorker' in navigator && typeof Capacitor === 'undefined' && location.protocol.startsWith('http')) {
        fetch('./service-worker.js', { method: 'HEAD' }).then(r => { if (r.ok) return navigator.serviceWorker.register('./service-worker.js'); }).catch(() => {});
    }
    })();
