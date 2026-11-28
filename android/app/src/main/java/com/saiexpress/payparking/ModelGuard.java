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
        if (strikes >= 1) {
            String at = p.getString("stage", "?"); p.edit().putInt("strikes", strikes).remove("trying").commit(); state = "off: crashed at " + at; return false; }
        p.edit().putInt("strikes", strikes).putBoolean("trying", true).commit();
        return true;
    }
    /** Remember the step being done now, so a crash shows where it happened (engine start / model load / first run). */
    void step(Context c, String what) { prefs(c).edit().putString("stage", what).commit(); }
    /** Why Android closed this app the last time (Android 11+): e.g. "low memory" or "native crash". */
    static String lastExit(Context c) {
        if (android.os.Build.VERSION.SDK_INT < 30) return "";
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
            java.util.List<android.app.ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(c.getPackageName(), 0, 1);
            if (list.isEmpty()) return "";
            android.app.ApplicationExitInfo e = list.get(0);
            String r;
            switch (e.getReason()) {
                case android.app.ApplicationExitInfo.REASON_LOW_MEMORY: r = "LOW MEMORY"; break;
                case android.app.ApplicationExitInfo.REASON_CRASH_NATIVE: r = "native crash"; break;
                case android.app.ApplicationExitInfo.REASON_CRASH: r = "Java crash"; break;
                case android.app.ApplicationExitInfo.REASON_ANR: r = "not responding"; break;
                case android.app.ApplicationExitInfo.REASON_SIGNALED: r = "killed by signal " + e.getStatus(); break;
                case android.app.ApplicationExitInfo.REASON_EXIT_SELF: r = "closed normally"; break;
                case android.app.ApplicationExitInfo.REASON_USER_REQUESTED: r = "closed by user"; break;
                default: r = "reason " + e.getReason();
            }
            String d = e.getDescription();
            long ago = (System.currentTimeMillis() - e.getTimestamp()) / 60000;
            return "last close: " + r + (d != null && !d.isEmpty() ? " (" + (d.length() > 50 ? d.substring(0, 50) : d) + ")" : "") + ", " + ago + " min ago, RAM " + (am.getMemoryClass()) + " MB";
        } catch (Throwable t) { return ""; }
    }
    void loaded(Context c) { prefs(c).edit().remove("trying").putInt("strikes", 0).commit(); state = "ok"; }
    void failed(Context c, Throwable e) {
        prefs(c).edit().remove("trying").commit();
        String m = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
        state = "off: " + (m.length() > 60 ? m.substring(0, 60) : m);
    }
}
