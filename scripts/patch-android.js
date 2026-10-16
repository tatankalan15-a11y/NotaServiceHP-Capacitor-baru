// Menambahkan permission Android yang dibutuhkan (aman dijalankan berulang).
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'android/app/src/main/AndroidManifest.xml');
if (!fs.existsSync(f)) throw new Error('AndroidManifest.xml tidak ditemukan. Jalankan npx cap add android terlebih dahulu.');
let x = fs.readFileSync(f, 'utf8');
const permissions = [
  '<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />',
  '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />',
  '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
  '<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.READ_CONTACTS" />',
  '<uses-permission android:name="android.permission.WRITE_CONTACTS" />'
];
const missing = permissions.filter(p => !x.includes(p.match(/android:name="([^"]+)"/)[1]));
if (missing.length) {
  if (!x.includes('<application')) throw new Error('Tag <application> tidak ditemukan di AndroidManifest.xml');
  x = x.replace('<application', missing.join('\n    ') + '\n    <application');
}
if (!x.includes('android.hardware.camera')) x = x.replace('<application', '<uses-feature android:name="android.hardware.camera" android:required="false" />\n    <application');
// Photo picker (Google Play services) agar galeri langsung siap di Android < 13, sesuai dokumentasi @capacitor/camera.
if (!x.includes('photopicker_activity:0:required') && x.includes('</application>')) {
  x = x.replace('</application>', '    <service android:name="com.google.android.gms.metadata.ModuleDependencies" android:enabled="false" android:exported="false">\n            <intent-filter><action android:name="com.google.android.gms.metadata.MODULE_DEPENDENCIES" /></intent-filter>\n            <meta-data android:name="photopicker_activity:0:required" android:value="" />\n        </service>\n    </application>');
}
fs.writeFileSync(f, x);
console.log('AndroidManifest.xml berhasil dipatch');

// ---- Plugin native: kirim gambar nota langsung ke chat WhatsApp nomor pelanggan ----
const javaDir = path.join(__dirname, '..', 'android/app/src/main/java/com/notaservice/hp');
fs.mkdirSync(javaDir, { recursive: true });
for (const f of ['WhatsAppSharePlugin.java', 'EscPosPrinterPlugin.java']) fs.copyFileSync(path.join(__dirname, 'native', f), path.join(javaDir, f));
fs.writeFileSync(path.join(javaDir, 'MainActivity.java'), `package com.notaservice.hp;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WhatsAppSharePlugin.class);
        registerPlugin(EscPosPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
let m = fs.readFileSync(f, 'utf8');
if (!m.includes('com.whatsapp.w4b')) {
  m = m.replace('<application', '<queries>\n        <package android:name="com.whatsapp" />\n        <package android:name="com.whatsapp.w4b" />\n    </queries>\n    <application');
  fs.writeFileSync(f, m);
}
console.log('Plugin WhatsAppShare dan EscPosPrinter berhasil ditambahkan');

// ---- versionCode otomatis naik tiap build (syarat Android agar APK bisa meng-update versi lama) ----
const gradleFile = path.join(__dirname, '..', 'android/app/build.gradle');
if (fs.existsSync(gradleFile)) {
  let g = fs.readFileSync(gradleFile, 'utf8');
  const code = Math.floor(Date.now() / 60000); // menit sejak 1970, selalu bertambah
  g = g.replace(/versionCode\s+\d+/, 'versionCode ' + code).replace(/versionName\s+\"[^\"]*\"/, 'versionName "1.0.' + code + '"');
  fs.writeFileSync(gradleFile, g);
  console.log('versionCode =', code);
}
