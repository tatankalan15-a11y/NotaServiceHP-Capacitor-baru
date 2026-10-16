package com.notaservice.hp;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Mengirim gambar langsung ke chat WhatsApp nomor tertentu.
 * Memakai intent ACTION_SEND + extra "jid" (nomor@s.whatsapp.net).
 * Pengguna tetap menekan tombol kirim di WhatsApp.
 */
@CapacitorPlugin(name = "WhatsAppShare")
public class WhatsAppSharePlugin extends Plugin {

    @PluginMethod
    public void sendImage(PluginCall call) {
        String uriStr = call.getString("uri");
        String phone = call.getString("phone");
        String text = call.getString("text");
        String pkgPref = call.getString("pkg");
        if (uriStr == null || phone == null) {
            call.reject("uri dan phone wajib diisi");
            return;
        }
        phone = phone.replaceAll("\\D", "");
        if (phone.isEmpty()) {
            call.reject("Nomor tidak valid");
            return;
        }

        try {
            Context ctx = getContext();
            Uri parsed = Uri.parse(uriStr);
            String filePath = parsed.getPath();
            if (filePath == null) {
                call.reject("Path file tidak valid");
                return;
            }
            File file = new File(filePath);
            Uri contentUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);

            String[] packages = {"com.whatsapp", "com.whatsapp.w4b"};
            if ("com.whatsapp.w4b".equals(pkgPref)) packages = new String[]{"com.whatsapp.w4b"};
            else if ("com.whatsapp".equals(pkgPref)) packages = new String[]{"com.whatsapp"};
            for (String pkg : packages) {
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType("image/jpeg");
                intent.setPackage(pkg);
                intent.putExtra(Intent.EXTRA_STREAM, contentUri);
                if (text != null && !text.isEmpty()) intent.putExtra(Intent.EXTRA_TEXT, text);
                intent.putExtra("jid", phone + "@s.whatsapp.net");
                intent.setClipData(ClipData.newRawUri("nota", contentUri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    getActivity().startActivity(intent);
                    JSObject ret = new JSObject();
                    ret.put("package", pkg);
                    call.resolve(ret);
                    return;
                } catch (ActivityNotFoundException ignored) {
                    // coba paket berikutnya
                }
            }
            call.reject("WhatsApp tidak terpasang");
        } catch (Exception e) {
            call.reject("Gagal membuka WhatsApp: " + e.getMessage());
        }
    }
}
