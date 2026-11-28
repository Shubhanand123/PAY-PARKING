package com.saiexpress.payparking;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Collections;


/**
 * Reads the characters of a plate box (from PlateFinder) with our own model, trained on Indian plates
 * (fast-plate-ocr CCT-XS, MIT, fine-tuned on openly licensed Indian plate photos + synthetic plates).
 * Input: the plate box resized to 128 x 64 RGB. Output: up to 10 characters, each with its probability.
 * Loaded only when the scanner opens; a crash guard switches it off on a POS where it ever fails.
 */
final class PlateTextReader {
    private static final String TAG = "PlateTextReader";
    private org.tensorflow.lite.Interpreter tfl;
    private final java.nio.ByteBuffer in8 = java.nio.ByteBuffer.allocateDirect(128 * 64 * 3).order(java.nio.ByteOrder.nativeOrder());
    private final float[][][] out = new float[1][10][37];
    private static final String ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
    private static final int W = 128, H = 64;
    static final ModelGuard GUARD = new ModelGuard("reader");

    static final class Reading {
        final String text; final float confidence;
        final float[][] slots;  // [10][37] letter probabilities (for voting across frames)
        final float sharpness;  // Laplacian variance of the 128 x 64 picture that was read (higher = sharper)
        Reading(String t, float c) { this(t, c, null, 0f); }
        Reading(String t, float c, float[][] s, float sh) { text = t; confidence = c; slots = s; sharpness = sh; }
    }

    /** Letter-by-letter vote: each of the 10 slots adds up its probabilities over the frames (a moving vehicle, 2-4 frames). */
    static Reading vote(java.util.List<Reading> frames) {
        float[][] sum = null; int n = 0; float sharp = 0f;
        for (Reading r : frames) {
            if (r.slots == null) continue;
            if (sum == null) sum = new float[r.slots.length][r.slots[0].length];
            for (int i = 0; i < sum.length; i++) for (int k = 0; k < sum[i].length; k++) sum[i][k] += r.slots[i][k];
            n++; sharp = Math.max(sharp, r.sharpness);
        }
        if (sum == null) return new Reading("", 0f);
        for (float[] slot : sum) for (int k = 0; k < slot.length; k++) slot[k] /= n;
        return decode(sum, sharp);
    }

    private static Reading decode(float[][] slots, float sharpness) {
        StringBuilder text = new StringBuilder();
        float worst = 1f;
        for (float[] slot : slots) {
            int best = 0;
            for (int k = 1; k < slot.length; k++) if (slot[k] > slot[best]) best = k;
            char c = ALPHA.charAt(best);
            if (c == '_') continue; // padding
            text.append(c);
            worst = Math.min(worst, slot[best]);
        }
        return new Reading(text.toString(), text.length() == 0 ? 0f : worst, slots, sharpness);
    }

    /**
     * Night: when the plate picture is dark (mean brightness under 80 of 255), its brightness range (2nd..98th percentile)
     * is stretched to 0..255. Tested on the 163 test plates made dark and noisy: read exactly 80.4% -> 88.3%; normal
     * and glare plates unchanged (it applies to about 5% of normal plates). training/scripts: see the 28 Nov notes.
     */
    private void brightenIfDark() {
        int n = W * H; int[] hist = new int[256]; long sum = 0;
        for (int i = 0; i < n; i++) { int p = pixels[i]; int y = (((p >> 16) & 255) * 299 + ((p >> 8) & 255) * 587 + (p & 255) * 114) / 1000; hist[y]++; sum += y; }
        if (sum / n >= 80) return;
        int lo = 0, hi = 255, c = 0;
        for (int v = 0; v < 256; v++) { c += hist[v]; if (c >= n * 0.02) { lo = v; break; } }
        c = 0; for (int v = 255; v >= 0; v--) { c += hist[v]; if (c >= n * 0.02) { hi = v; break; } }
        if (hi - lo < 8) return;
        float k = 255f / (hi - lo);
        for (int i = 0; i < n; i++) {
            int p = pixels[i];
            int r = Math.max(0, Math.min(255, Math.round((((p >> 16) & 255) - lo) * k)));
            int g = Math.max(0, Math.min(255, Math.round((((p >> 8) & 255) - lo) * k)));
            int b = Math.max(0, Math.min(255, Math.round(((p & 255) - lo) * k)));
            pixels[i] = (p & 0xff000000) | (r << 16) | (g << 8) | b;
        }
    }

    /** Sharpness of the 128 x 64 picture: variance of the Laplacian of its grey levels (as in training/scripts/vote_sim.py). */
    private float sharpness() {
        int w = W, h = H; float[] g = grey; double sum = 0, sq = 0; int n = 0;
        for (int i = 0; i < w * h; i++) { int p = pixels[i]; g[i] = (((p >> 16) & 255) * 299 + ((p >> 8) & 255) * 587 + (p & 255) * 114) / 1000f; }
        for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
            int i = y * w + x; double l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i]; sum += l; sq += l * l; n++;
        }
        double m = sum / n; return (float) (sq / n - m * m);
    }

    private static volatile PlateTextReader shared;
    private static boolean failed;

    private final int[] pixels = new int[W * H];
    private final float[] grey = new float[W * H];

    static PlateTextReader ready() { return shared; }

    static void loadInBackground(Context context) {
        if (shared != null || failed) return;
        Context app = context.getApplicationContext();
        new Thread(() -> get(app), "plate-reader-load").start();
    }

    static synchronized PlateTextReader get(Context context) {
        if (shared == null && !failed) {
            if (!GUARD.begin(context)) { failed = true; return null; }
            try { shared = new PlateTextReader(context.getApplicationContext()); GUARD.loaded(context); }
            catch (Throwable e) { failed = true; GUARD.failed(context, e); android.util.Log.w("PlateTextReader", "unavailable: " + e); }
        }
        return shared;
    }

    private PlateTextReader(Context context) throws Exception {
        GUARD.step(context, "model load");
        tfl = Tfl.open(context, "models/plate_reader.tflite");
        GUARD.step(context, "first run");
        read(Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)); // warm up
    }

    /** Characters of the plate in this box and the lowest character probability (0..1). */
    synchronized Reading read(Bitmap box) throws Exception {
        Bitmap small = Bitmap.createScaledBitmap(box, W, H, true);
        small.getPixels(pixels, 0, W, 0, 0, W, H);
        brightenIfDark();
        in8.rewind();
        for (int p : pixels) { in8.put((byte) ((p >> 16) & 0xff)); in8.put((byte) ((p >> 8) & 0xff)); in8.put((byte) (p & 0xff)); }
        in8.rewind();
        tfl.run(in8, out);
        {
            float[][] slots = out[0]; // [10][37] probabilities
            return decode(slots, sharpness());
        }
    }
}
