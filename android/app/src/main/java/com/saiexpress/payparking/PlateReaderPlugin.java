package com.saiexpress.payparking;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import java.lang.reflect.Method;
import android.os.Build;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

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

    @Override
    public void load() {
        PlateScanActivity.warmUp(getContext()); // load the camera and text reader early: the first scan opens fast
        listenToHardwareScanner();
    }

    // ---------- Built-in barcode scanner (the POS's scan button) ----------
    // Urovo-based POS machines (TVS i9200) can send each scan as a system broadcast instead of typing it.
    // Every common broadcast name is listened to, and the scan is passed to the page as a "hardwareScan" event.
    private static final String[] SCAN_ACTIONS = {
        "android.intent.ACTION_DECODE_DATA", "android.intent.action.SCANRESULT", "com.android.server.scannerservice.broadcast",
        "urovo.rcv.message", "scanner.rcv.message", "com.scanner.broadcast", "android.intent.action.SCAN_RESULT",
    };
    private static final String[] SCAN_EXTRAS = { "barcode_string", "barcodeData", "scannerdata", "data", "value", "decode_data", "SCAN_BARCODE1", "barocode" };
    private android.content.BroadcastReceiver scanReceiver;

    private void listenToHardwareScanner() {
        scanReceiver = new android.content.BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String value = null;
                for (String key : SCAN_EXTRAS) {
                    Object v = intent.getExtras() != null ? intent.getExtras().get(key) : null;
                    if (v instanceof String && !((String) v).isEmpty()) { value = (String) v; break; }
                    if (v instanceof byte[] && ((byte[]) v).length > 0) {
                        int len = intent.getIntExtra("length", ((byte[]) v).length);
                        value = new String((byte[]) v, 0, Math.min(len, ((byte[]) v).length), java.nio.charset.StandardCharsets.UTF_8);
                        break;
                    }
                }
                if (value == null) return;
                JSObject out = new JSObject();
                out.put("value", value.trim());
                notifyListeners("hardwareScan", out);
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter();
        for (String a : SCAN_ACTIONS) filter.addAction(a);
        try { androidx.core.content.ContextCompat.registerReceiver(getContext(), scanReceiver, filter, androidx.core.content.ContextCompat.RECEIVER_EXPORTED); }
        catch (Throwable ignored) { /* no scanner service */ }
    }

    @Override
    protected void handleOnDestroy() {
        if (scanReceiver != null) try { getContext().unregisterReceiver(scanReceiver); } catch (Throwable ignored) { /* not registered */ }
        super.handleOnDestroy();
    }

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
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
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
                if (data.hasExtra(PlateScanActivity.RESULT_PICTURE)) out.put("picture", data.getStringExtra(PlateScanActivity.RESULT_PICTURE));
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

    /** Prints the current page (only the slip/receipt is visible in print) through Android's print service,
     *  on a 58 mm roll. Which printer is used depends on the print services installed on the POS. */
    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "PARKAR");
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                WebView view = getBridge().getWebView();
                PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(name);
                PrintAttributes roll = new PrintAttributes.Builder()
                    .setMediaSize(new PrintAttributes.MediaSize("roll58", "58 mm roll", 2283, 7874))
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();
                manager.print(name, adapter, roll);
                call.resolve();
            } catch (Exception e) {
                call.reject("Printing is not available on this device.");
            }
        });
    }

    // ---------- Built-in printer (Urovo-based POS such as the TVS i9200) ----------
    // These terminals expose their thermal printer through the system class android.device.PrinterManager
    // (the same one the "SPrinter" test app uses). It is called by reflection, so the app still installs and
    // runs on phones without it; there the web page falls back to Android's print screen.
    private Object printer() throws Exception {
        Class<?> c = Class.forName("android.device.PrinterManager");
        return c.getConstructor().newInstance();
    }
    private static Object call(Object target, String[] names, Class<?>[] types, Object... args) throws Exception {
        for (String n : names) {
            try { Method m = target.getClass().getMethod(n, types); return m.invoke(target, args); }
            catch (NoSuchMethodException ignored) { /* try the next name */ }
        }
        throw new NoSuchMethodException(names[0]);
    }

    /** Is there a built-in printer we can drive directly? */
    @PluginMethod
    public void printerInfo(PluginCall call) {
        JSObject out = new JSObject();
        try { printer(); out.put("builtIn", true); } catch (Throwable e) { out.put("builtIn", false); out.put("reason", String.valueOf(e)); }
        out.put("model", Build.MODEL); out.put("maker", Build.MANUFACTURER);
        call.resolve(out);
    }

    private static String statusText(int code) {
        switch (code) {
            case -1: return "The printer is out of paper.";
            case -2: return "The printer is too hot. Wait a minute and try again.";
            case -3: return "The battery is too low to print. Charge the POS.";
            case -4: return "The printer is busy. Try again.";
            default: return "The printer reported an error (" + code + ").";
        }
    }

    /** Prints a black-and-white image (PNG, base64, 384 dots wide for 58 mm) straight on the built-in printer: no print screen. */
    @PluginMethod
    public void printImage(PluginCall call) {
        String data = call.getString("image", "");
        int gray = call.getInt("gray", 2);
        new Thread(() -> {
            Object pm = null;
            StringBuilder log = new StringBuilder();
            try {
                byte[] bytes = Base64.decode(data.replaceFirst("^data:image/[a-z]+;base64,", ""), Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) { call.reject("The receipt image could not be read."); return; }
                log.append("img ").append(bmp.getWidth()).append("x").append(bmp.getHeight());
                pm = printer();
                log.append(" open=").append(call(pm, new String[] { "open", "prn_open" }, new Class<?>[0]));
                try { log.append(" gray=").append(call(pm, new String[] { "setGrayLevel", "prn_setBlack" }, new Class<?>[] { int.class }, gray)); } catch (Throwable ignored) { /* optional */ }
                // The status before printing is not reliable on every model (the i9200 says "no paper" with paper loaded),
                // so it is only logged. The result of printPage decides.
                try { log.append(" status=").append(call(pm, new String[] { "getStatus", "prn_getStatus" }, new Class<?>[0])); } catch (Throwable ignored) { /* optional */ }
                log.append(" page=").append(call(pm, new String[] { "setupPage", "prn_setupPage" }, new Class<?>[] { int.class, int.class }, 384, -1));
                log.append(" draw=").append(call(pm, new String[] { "drawBitmap", "prn_drawBitmap" }, new Class<?>[] { Bitmap.class, int.class, int.class }, bmp, 0, 0));
                Object ret = call(pm, new String[] { "printPage", "prn_printPage" }, new Class<?>[] { int.class }, 0);
                if (ret instanceof Integer && (Integer) ret == -4) { Thread.sleep(600); ret = call(pm, new String[] { "printPage", "prn_printPage" }, new Class<?>[] { int.class }, 0); }
                log.append(" print=").append(ret);
                try { call(pm, new String[] { "paperFeed", "prn_paperForWard" }, new Class<?>[] { int.class }, 64); } catch (Throwable ignored) { /* optional */ }
                if (ret instanceof Integer && (Integer) ret < 0) { call.reject(statusText((Integer) ret) + " [" + log + "]"); return; }
                JSObject out = new JSObject(); out.put("printed", true); out.put("log", log.toString()); call.resolve(out);
            } catch (ClassNotFoundException e) {
                call.reject("NO_BUILT_IN_PRINTER");
            } catch (Throwable e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                call.reject("Printing failed: " + cause + " [" + log + "]");
            } finally {
                if (pm != null) try { call(pm, new String[] { "close", "prn_close" }, new Class<?>[0]); } catch (Throwable ignored) { /* already closed */ }
            }
        }).start();
    }
}
