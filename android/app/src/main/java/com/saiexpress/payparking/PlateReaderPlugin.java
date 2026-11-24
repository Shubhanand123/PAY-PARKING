package com.saiexpress.payparking;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** JavaScript bridge: PlateReader.scan(), PlateReader.version(), PlateReader.openExternal(). */
@CapacitorPlugin(name = "PlateReader", permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") })
public class PlateReaderPlugin extends Plugin {

    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void cameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) launch(call);
        else call.reject("Camera permission was denied. Allow it in Android settings, or type the plate.", "permission");
    }

    private void launch(PluginCall call) {
        Intent intent = new Intent(getContext(), PlateScanActivity.class);
        intent.putExtra(PlateScanActivity.EXTRA_QR, Boolean.TRUE.equals(call.getBoolean("qr", false)));
        intent.putExtra(PlateScanActivity.EXTRA_TITLE, call.getString("title", "Scan plate"));
        startActivityForResult(call, intent, "scanResult");
    }

    @ActivityCallback
    private void scanResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            if (data.hasExtra(PlateScanActivity.RESULT_QR)) out.put("qr", data.getStringExtra(PlateScanActivity.RESULT_QR));
            if (data.hasExtra(PlateScanActivity.RESULT_PLATE)) {
                out.put("plate", data.getStringExtra(PlateScanActivity.RESULT_PLATE));
                JSArray alternatives = new JSArray();
                String[] list = data.getStringArrayExtra(PlateScanActivity.RESULT_ALTERNATIVES);
                if (list != null) for (String p : list) alternatives.put(p);
                out.put("alternatives", alternatives);
            }
        } else {
            out.put("cancelled", true);
        }
        call.resolve(out);
    }

    /** Native app version, so the web app can offer an update when a newer APK exists. */
    @PluginMethod
    public void version(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            JSObject out = new JSObject();
            out.put("versionCode", code);
            out.put("versionName", info.versionName);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Version unavailable");
        }
    }

    /** Opens a link (the new APK) in the phone's browser, which downloads and installs it. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("Only https links can be opened."); return; }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
