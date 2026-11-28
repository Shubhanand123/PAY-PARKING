package com.saiexpress.payparking;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Crash guard for the on-device models (ONNX Runtime can crash natively, which no try/catch catches).
 * A model is marked "trying" while it loads. If the app dies during loading, that counts as one strike.
 * One crash switches that model off on this POS (models load one after the other, so only the culprit is
 * switched off); the count starts again with every new app version.
 */
final class ModelGuard {
    private final String name;
    volatile String state = "loading";   // loading / ok / off: reason
    ModelGuard(String name) { this.name = name; }

    private SharedPreferences prefs(Context c) { return c.getApplicationContext().getSharedPreferences("model_guard_" + name, Context.MODE_PRIVATE); }
    private static int version(Context c) {
        try { return (int) androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(c.getPackageManager().getPackageInfo(c.getPackageName(), 0)); }
        catch (Exception e) { return 0; }
    }

    /** True if loading may be tried now. Call before loading. */
    boolean begin(Context c) {
        SharedPreferences p = prefs(c);
        int v = version(c);
        if (p.getInt("version", -1) != v) p.edit().clear().putInt("version", v).commit();
        int strikes = p.getInt("strikes", 0) + (p.getBoolean("trying", false) ? 1 : 0);
        if (strikes >= 1) { p.edit().putInt("strikes", strikes).remove("trying").commit(); state = "off: crashed on this POS (" + android.os.Build.SUPPORTED_ABIS[0] + ", Android " + android.os.Build.VERSION.RELEASE + ")"; return false; }
        p.edit().putInt("strikes", strikes).putBoolean("trying", true).commit();
        return true;
    }
    void loaded(Context c) { prefs(c).edit().remove("trying").putInt("strikes", 0).commit(); state = "ok"; }
    void failed(Context c, Throwable e) {
        prefs(c).edit().remove("trying").commit();
        String m = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
        state = "off: " + (m.length() > 60 ? m.substring(0, 60) : m);
    }
}
