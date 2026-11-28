package com.saiexpress.payparking;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.Collections;


/**
 * Finds the number plate in a camera picture (YOLOX-nano, 224 x 224, Apache-2.0, trained by us on Indian plate photos:
 * training/scripts/yolox_train.py). Tested on the 163 test plates: found 98.8% (old YOLOv9-t 256: 95.7%), tight box 95.7%
 * (old 79.3%), 2.6x faster on a CPU. The old model's output format still works if its file is put back.
 * Runs on the CPU (all cores). Protected by a crash guard: if it ever takes the app down, it stays off on that phone.
 * Returns the plate box in the picture's own pixels, so the text reader only has to read that small box.
 */
final class PlateFinder {
    private static final String TAG = "PlateFinder";
    private static final float MIN_SCORE = 0.3f;

    private static volatile PlateFinder shared;
    private static boolean failed;
    private int errors;

    private final org.tensorflow.lite.Interpreter tfl;
    final String engine; // shown in the timing line
    private final int SIZE; // from the model: 224 (YOLOX) or 256 (old YOLOv9)
    private final Bitmap board;
    private final Canvas canvas;
    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
    private final int[] pixels;
    private final java.nio.ByteBuffer input;
    private final float[][] rows;

    // Crash guard: a flag is written before the model first loads and runs, and cleared once it has worked.
    // If the app is killed in between (a native crash), the flag is still there at the next start and the finder
    // stays switched off on this phone; the scanner then reads the plate the old way.
    static final ModelGuard GUARD = new ModelGuard("finder");

    /** The finder if it is already loaded, without waiting (the scanner reads the old way until then). */
    static PlateFinder ready() { return shared; }

    /** Loads the finder in the background (called when the scanner opens, never at app start). */
    static void loadInBackground(Context context) {
        if (shared != null || failed) return;
        Context app = context.getApplicationContext();
        new Thread(() -> get(app), "plate-finder-load").start();
    }

    /** The shared finder, loaded once. Null if the model can't run on this POS. */
    static synchronized PlateFinder get(Context context) {
        if (shared == null && !failed) {
            if (!GUARD.begin(context)) { failed = true; return null; }
            try { shared = new PlateFinder(context.getApplicationContext()); GUARD.loaded(context); }
            catch (Throwable e) { failed = true; GUARD.failed(context, e); android.util.Log.w("PlateFinder", "unavailable: " + e); }
        }
        return shared;
    }

    private PlateFinder(Context context) throws Exception {
        GUARD.step(context, "model load");
        tfl = Tfl.open(context, "models/plate_finder_224.tflite");
        engine = "TFLite";
        int[] shape = tfl.getInputTensor(0).shape(); // [1, 224, 224, 3]
        SIZE = shape[1];
        int[] outShape = tfl.getOutputTensor(0).shape();
        rows = new float[outShape[0]][outShape[1]];
        board = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888); canvas = new Canvas(board);
        pixels = new int[SIZE * SIZE]; input = Tfl.floats(3 * SIZE * SIZE);
        GUARD.step(context, "first run");
        find(Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)); // first run is slow: do it now, not on the first vehicle
    }

    private static byte[] read(Context context, String asset) throws Exception {
        try (InputStream in = context.getAssets().open(asset); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /** Runs the model. If it keeps failing, the finder is switched off for this session. */
    private void run() throws Exception {
        try { tfl.run(input, rows); }
        catch (Exception e) {
            if (++errors >= 3) {
                Log.w(TAG, "Plate finder keeps failing: switched off for this session: " + e);
                synchronized (PlateFinder.class) { failed = true; shared = null; }
            }
            throw e;
        }
    }

    /** The plate box nearest the middle of the upright picture, or null. */
    synchronized Rect find(Bitmap picture) throws Exception { return find(picture, 0); }

    /**
     * Same, for a raw camera picture that still needs turning by `rotation` degrees: the picture is turned while it is
     * drawn into the small 256 x 256 board, so the full-size picture never has to be copied upright.
     * The box is returned in upright-picture pixels.
     */
    synchronized Rect find(Bitmap raw, int rotation) throws Exception {
        boolean sideways = rotation == 90 || rotation == 270;
        int w = sideways ? raw.getHeight() : raw.getWidth(), h = sideways ? raw.getWidth() : raw.getHeight();
        // Letterbox: keep the shape, pad with grey (as the model was trained).
        float r = Math.min((float) SIZE / w, (float) SIZE / h);
        float nw = w * r, nh = h * r, dx = (SIZE - nw) / 2f, dy = (SIZE - nh) / 2f;
        canvas.drawColor(Color.rgb(114, 114, 114));
        android.graphics.Matrix m = new android.graphics.Matrix();
        m.postRotate(rotation);
        if (rotation == 90) m.postTranslate(raw.getHeight(), 0);
        else if (rotation == 180) m.postTranslate(raw.getWidth(), raw.getHeight());
        else if (rotation == 270) m.postTranslate(0, raw.getWidth());
        m.postScale(r, r);
        m.postTranslate(dx, dy);
        canvas.drawBitmap(raw, m, paint);
        board.getPixels(pixels, 0, SIZE, 0, 0, SIZE, SIZE);
        input.rewind();
        for (int i = 0; i < SIZE * SIZE; i++) { // NHWC, 0..1
            int p = pixels[i];
            input.putFloat(((p >> 16) & 0xff) / 255f); input.putFloat(((p >> 8) & 0xff) / 255f); input.putFloat((p & 0xff) / 255f);
        }
        input.rewind();
        run();
        {
            Rect best = null;
            double bestScore = -1;
            for (float[] row : rows) {
                int o = row.length >= 7 ? 1 : 0; float sc = row.length >= 7 ? row[6] : row.length == 5 ? row[4] : -1;
                if (sc < MIN_SCORE) continue;
                float x1 = (row[o] - dx) / r, y1 = (row[o + 1] - dy) / r, x2 = (row[o + 2] - dx) / r, y2 = (row[o + 3] - dy) / r;
                double cx = (x1 + x2) / 2 / w - 0.5, cy = (y1 + y2) / 2 / h - 0.5;
                double score = sc - (cx * cx + cy * cy); // sure, and near the middle
                if (score > bestScore) { bestScore = score; best = new Rect(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)); }
            }
            return best;
        }
    }
}
