package com.notaservice.hp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Cetak ESC/POS langsung ke printer thermal tanpa aplikasi perantara.
 *
 * Transport:
 *  - Bluetooth Classic (SPP/RFCOMM) ke printer yang sudah di-pairing di pengaturan Bluetooth HP.
 *  - LAN/WiFi (raw socket, umumnya port 9100) ke printer thermal berjaringan.
 *
 * Plugin ini sengaja tipis: byte ESC/POS dibuat di sisi JavaScript (src/escpos.js)
 * lalu dikirim apa adanya sebagai base64 lewat method print().
 */
@CapacitorPlugin(
    name = "EscPosPrinter",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        )
    }
)
public class EscPosPrinterPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    // Ukuran potongan data & jeda antar potongan. Printer murah punya buffer kecil;
    // kalau cetakan terpotong / karakter acak, naikkan CHUNK_DELAY_MS atau turunkan CHUNK_SIZE.
    private static final int CHUNK_SIZE = 512;
    private static final int CHUNK_DELAY_MS = 25;
    // Jeda sebelum koneksi ditutup agar buffer printer habis tercetak (tutup terlalu cepat = nota terpotong).
    private static final int MIN_FLUSH_WAIT_MS = 700;
    private static final int MAX_FLUSH_WAIT_MS = 4000;
    private static final int TCP_CONNECT_TIMEOUT_MS = 5000;

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------------ izin

    /** Android 12+ (API 31) butuh BLUETOOTH_CONNECT (+ SCAN). Di bawah itu izin instal cukup. */
    private boolean needsRuntimeBluetoothPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }

    private boolean hasBluetoothPermission() {
        if (!needsRuntimeBluetoothPermission()) return true;
        Context ctx = getContext();
        boolean connect = ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT)
            == PackageManager.PERMISSION_GRANTED;
        boolean scan = ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_SCAN)
            == PackageManager.PERMISSION_GRANTED;
        return connect && scan;
    }

    private boolean shouldShowRationale() {
        if (!needsRuntimeBluetoothPermission()) return false;
        try {
            return ActivityCompat.shouldShowRequestPermissionRationale(
                    getActivity(), Manifest.permission.BLUETOOTH_CONNECT)
                || ActivityCompat.shouldShowRequestPermissionRationale(
                    getActivity(), Manifest.permission.BLUETOOTH_SCAN);
        } catch (Exception e) {
            return false;
        }
    }

    /** Status izin untuk JS: { bluetooth: "granted"|"denied"|"prompt" } */
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        if (!needsRuntimeBluetoothPermission()) {
            ret.put("bluetooth", "granted");
            call.resolve(ret);
            return;
        }
        if (hasBluetoothPermission()) {
            ret.put("bluetooth", "granted");
        } else if (shouldShowRationale()) {
            // Sudah pernah ditolak, tapi dialog masih bisa muncul lagi
            ret.put("bluetooth", "prompt");
        } else {
            // Belum pernah diminta ATAU ditolak permanen ("jangan tanya lagi")
            // Capacitor memakai "prompt" untuk belum diminta; di sini kita bedakan lewat denied.
            // Cek aman: jika belum pernah request, shouldShowRationale=false juga.
            // Untuk UX, JS akan memanggil requestPermissions dulu.
            ret.put("bluetooth", "denied");
        }
        call.resolve(ret);
    }

    /**
     * Minta izin Bluetooth runtime (Android 12+).
     * JS harus await ini sebelum listPrinters/print.
     */
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasBluetoothPermission()) {
            JSObject ret = new JSObject();
            ret.put("bluetooth", "granted");
            call.resolve(ret);
            return;
        }
        if (!needsRuntimeBluetoothPermission()) {
            JSObject ret = new JSObject();
            ret.put("bluetooth", "granted");
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("bluetooth", call, "permissionsResult");
    }

    @PermissionCallback
    private void permissionsResult(PluginCall call) {
        JSObject ret = new JSObject();
        if (hasBluetoothPermission()) {
            ret.put("bluetooth", "granted");
            call.resolve(ret);
        } else {
            ret.put("bluetooth", "denied");
            // Jangan reject di sini agar JS bisa handle dan buka Settings
            call.resolve(ret);
        }
    }

    /** Buka halaman detail aplikasi di Pengaturan (untuk aktifkan izin manual). */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Tidak bisa membuka Pengaturan: " + e.getMessage());
        }
    }

    /** Lanjut bila izin sudah ada; kalau belum, minta dulu lalu panggil permissionCallback. */
    private boolean ensureBluetoothPermission(PluginCall call) {
        if (hasBluetoothPermission()) return true;
        requestPermissionForAlias("bluetooth", call, "permissionCallback");
        return false;
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (!hasBluetoothPermission()) {
            call.reject(
                "Izin Bluetooth ditolak. Buka Pengaturan HP → Aplikasi → Nota Service HP → Izin → aktifkan 'Perangkat sekitar' / Nearby devices, lalu coba lagi.",
                "PERMISSION_DENIED"
            );
            return;
        }
        String method = call.getMethodName();
        if ("listPrinters".equals(method)) doListPrinters(call);
        else if ("print".equals(method)) doPrint(call);
        else call.reject("Metode tidak dikenal: " + method);
    }

    // ------------------------------------------------------------- listPrinters

    /** Daftar printer Bluetooth yang sudah di-pairing. Hasil: { printers: [{ name, address }] } */
    @PluginMethod
    public void listPrinters(PluginCall call) {
        if (!ensureBluetoothPermission(call)) return;
        doListPrinters(call);
    }

    @SuppressLint("MissingPermission")
    private void doListPrinters(PluginCall call) {
        try {
            BluetoothAdapter adapter = getAdapter();
            if (adapter == null) {
                call.reject("Perangkat ini tidak punya Bluetooth", "NO_BLUETOOTH");
                return;
            }
            if (!adapter.isEnabled()) {
                call.reject("Bluetooth mati. Nyalakan Bluetooth lalu coba lagi.", "BLUETOOTH_OFF");
                return;
            }
            JSArray list = new JSArray();
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice d : bonded) {
                    JSObject o = new JSObject();
                    String name = d.getName();
                    o.put("name", name != null ? name : d.getAddress());
                    o.put("address", d.getAddress());
                    list.put(o);
                }
            }
            JSObject ret = new JSObject();
            ret.put("printers", list);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject(
                "Izin Bluetooth belum diberikan. Aktifkan 'Perangkat sekitar' di Pengaturan aplikasi.",
                "PERMISSION_DENIED"
            );
        } catch (Exception e) {
            call.reject("Gagal membaca daftar printer: " + e.getMessage());
        }
    }

    // -------------------------------------------------------------------- print

    /**
     * Kirim byte ESC/POS ke printer.
     * Parameter:
     *  - data    (wajib)  : byte ESC/POS dalam base64
     *  - type    (opsional): "bluetooth" (default) atau "tcp"
     *  - address (wajib)  : MAC address printer Bluetooth, atau host/IP printer LAN
     *  - port    (opsional): port TCP, default 9100
     */
    @PluginMethod
    public void print(PluginCall call) {
        if (call.getString("data") == null || call.getString("address") == null) {
            call.reject("data dan address wajib diisi");
            return;
        }
        String type = call.getString("type", "bluetooth");
        if ("bluetooth".equals(type) && !ensureBluetoothPermission(call)) return;
        doPrint(call);
    }

    private void doPrint(final PluginCall call) {
        final String type = call.getString("type", "bluetooth");
        final String address = call.getString("address", "").trim();
        final int port = call.getInt("port", 9100);
        final byte[] bytes;
        try {
            bytes = Base64.decode(call.getString("data"), Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("Data cetak bukan base64 yang valid");
            return;
        }
        if (bytes.length == 0) {
            call.reject("Data cetak kosong");
            return;
        }
        if (address.isEmpty()) {
            call.reject("Alamat printer kosong");
            return;
        }

        io.execute(() -> {
            try {
                if ("tcp".equals(type)) printTcp(address, port, bytes);
                else printBluetooth(address, bytes);
                JSObject ret = new JSObject();
                ret.put("bytes", bytes.length);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(
                    "Izin Bluetooth belum diberikan. Aktifkan 'Perangkat sekitar' di Pengaturan aplikasi.",
                    "PERMISSION_DENIED"
                );
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Gagal mencetak");
            }
        });
    }

    // --------------------------------------------------------------- Bluetooth

    private BluetoothAdapter getAdapter() {
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return mgr != null ? mgr.getAdapter() : null;
    }

    @SuppressLint("MissingPermission")
    private void printBluetooth(String address, byte[] bytes) throws IOException {
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null) throw new IOException("Perangkat ini tidak punya Bluetooth");
        if (!adapter.isEnabled()) throw new IOException("Bluetooth mati. Nyalakan Bluetooth lalu coba lagi.");
        if (!BluetoothAdapter.checkBluetoothAddress(address.toUpperCase())) {
            throw new IOException("Alamat printer tidak valid: " + address);
        }

        BluetoothDevice device = adapter.getRemoteDevice(address.toUpperCase());
        // Pencarian perangkat yang sedang berjalan memperlambat / menggagalkan connect().
        if (adapter.isDiscovering()) adapter.cancelDiscovery();

        BluetoothSocket socket = connectWithFallback(device);
        try {
            writeChunked(socket.getOutputStream(), bytes);
        } finally {
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    /** Urutan percobaan: SPP aman -> SPP tidak aman -> reflection channel 1 (untuk printer China yang rewel). */
    @SuppressLint("MissingPermission")
    private BluetoothSocket connectWithFallback(BluetoothDevice device) throws IOException {
        IOException last = null;

        try {
            BluetoothSocket s = device.createRfcommSocketToServiceRecord(SPP_UUID);
            if (tryConnect(s)) return s;
        } catch (IOException e) { last = e; }

        try {
            BluetoothSocket s = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
            if (tryConnect(s)) return s;
        } catch (IOException e) { last = e; }

        try {
            Method m = device.getClass().getMethod("createRfcommSocket", int.class);
            BluetoothSocket s = (BluetoothSocket) m.invoke(device, 1);
            if (s != null && tryConnect(s)) return s;
        } catch (Exception e) {
            if (e instanceof IOException) last = (IOException) e;
        }

        throw new IOException("Tidak bisa terhubung ke printer. Pastikan printer menyala, dekat, sudah di-pairing, dan tidak sedang dipakai aplikasi lain."
            + (last != null && last.getMessage() != null ? " (" + last.getMessage() + ")" : ""));
    }

    @SuppressLint("MissingPermission")
    private boolean tryConnect(BluetoothSocket s) {
        try {
            s.connect();
            return true;
        } catch (IOException e) {
            try { s.close(); } catch (IOException ignored) { }
            return false;
        }
    }

    // --------------------------------------------------------------------- TCP

    private void printTcp(String host, int port, byte[] bytes) throws IOException {
        if (port < 1 || port > 65535) throw new IOException("Port tidak valid: " + port);
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), TCP_CONNECT_TIMEOUT_MS);
            socket.setTcpNoDelay(true);
            writeChunked(socket.getOutputStream(), bytes);
        } catch (IOException e) {
            throw new IOException("Tidak bisa terhubung ke printer " + host + ":" + port
                + ". Pastikan HP dan printer di jaringan WiFi yang sama. (" + e.getMessage() + ")");
        } finally {
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    // ------------------------------------------------------------------ umum

    private void writeChunked(OutputStream out, byte[] bytes) throws IOException {
        for (int off = 0; off < bytes.length; off += CHUNK_SIZE) {
            int len = Math.min(CHUNK_SIZE, bytes.length - off);
            out.write(bytes, off, len);
            out.flush();
            if (off + len < bytes.length) sleep(CHUNK_DELAY_MS);
        }
        // Beri waktu printer menghabiskan buffer sebelum koneksi ditutup.
        sleep(Math.min(MAX_FLUSH_WAIT_MS, MIN_FLUSH_WAIT_MS + bytes.length / 20));
    }

    private void sleep(long ms) throws IOException {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Pencetakan dibatalkan");
        }
    }
}
