package com.saiexpress.payparking;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.Collections;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Finds the 4 corners of the plate inside the finder's (grown) box and warps the plate flat, straight to the
 * reader's 128 x 64 picture. Handles side angles properly (perspective), not only tilt and lean.
 * Model: MobileNetV3-small (torchvision, BSD), trained by us (training/scripts/corner_train.py).
 * Input: the grown box resized to 160 x 80, RGB 0..1. Output: x,y of top-left, top-right, bottom-right, bottom-left
 * as fractions of the box. Loaded only when the scanner opens; a crash guard switches it off on a POS where it fails.
 */
final class PlateCorners {
    private static final String TAG = "PlateCorners";
    private static final int W = 160, H = 80, OUT_W = 128, OUT_H = 64;
    private static final float MX = 0.05f, MY = 0.10f; // plate edges inside the reader picture (as in training)
    private static final String PREFS = "plate_corners", TRYING = "trying_v1", OFF = "off_v1";

    private static volatile PlateCorners shared;
    private static boolean failed;

    private final OrtEnvironment env;
    private final OrtSession session;
    private final String inputName;
    private final int[] pixels = new int[W * H];
    private final FloatBuffer input = FloatBuffer.allocate(3 * W * H);

    static PlateCorners ready() { return shared; }

    static void loadInBackground(Context context) {
        if (shared != null || failed) return;
        Context app = context.getApplicationContext();
        new Thread(() -> get(app), "plate-corners-load").start();
    }

    static synchronized PlateCorners get(Context context) {
        if (shared == null && !failed) {
            android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (prefs.getBoolean(OFF, false)) { failed = true; return null; }
            if (prefs.getBoolean(TRYING, false)) { prefs.edit().putBoolean(OFF, true).remove(TRYING).commit(); failed = true; return null; }
            prefs.edit().putBoolean(TRYING, true).commit();
            try { shared = new PlateCorners(context); prefs.edit().remove(TRYING).commit(); }
            catch (Throwable e) { failed = true; prefs.edit().remove(TRYING).commit(); Log.w(TAG, "Plate corners unavailable: " + e); }
        }
        return shared;
    }

    private PlateCorners(Context context) throws Exception {
        byte[] model;
        try (InputStream in = context.getAssets().open("models/plate_corners.onnx"); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            model = out.toByteArray();
        }
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions cpu = new OrtSession.SessionOptions();
        cpu.setIntraOpNumThreads(2);
        cpu.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        session = env.createSession(model, cpu);
        inputName = session.getInputNames().iterator().next();
        flatten(Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)); // warm up
    }

    /** The plate in this grown box, warped flat to 128 x 64 (for PlateTextReader). */
    synchronized Bitmap flatten(Bitmap band) throws Exception {
        Bitmap small = Bitmap.createScaledBitmap(band, W, H, true);
        small.getPixels(pixels, 0, W, 0, 0, W, H);
        if (small != band) small.recycle();
        input.clear();
        float[] data = input.array();
        int plane = W * H;
        for (int i = 0; i < plane; i++) {
            int p = pixels[i];
            data[i] = ((p >> 16) & 0xff) / 255f;
            data[plane + i] = ((p >> 8) & 0xff) / 255f;
            data[2 * plane + i] = (p & 0xff) / 255f;
        }
        float[] q;
        try (OnnxTensor t = OnnxTensor.createTensor(env, input, new long[] { 1, 3, H, W });
             OrtSession.Result out = session.run(Collections.singletonMap(inputName, t))) {
            q = ((float[][]) out.get(0).getValue())[0];
        }
        float bw = band.getWidth(), bh = band.getHeight();
        float[] src = { q[0] * bw, q[1] * bh, q[2] * bw, q[3] * bh, q[4] * bw, q[5] * bh, q[6] * bw, q[7] * bh };
        float[] dst = { MX * OUT_W, MY * OUT_H, (1 - MX) * OUT_W, MY * OUT_H, (1 - MX) * OUT_W, (1 - MY) * OUT_H, MX * OUT_W, (1 - MY) * OUT_H };
        Matrix m = new Matrix();
        if (!m.setPolyToPoly(src, 0, dst, 0, 4)) return Bitmap.createScaledBitmap(band, OUT_W, OUT_H, true);
        // Edge pixels repeat outside the box (like the training warp), so a corner just outside the box never gives black.
        android.graphics.BitmapShader shader = new android.graphics.BitmapShader(band, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP);
        shader.setLocalMatrix(m);
        Paint p = new Paint(Paint.FILTER_BITMAP_FLAG); p.setShader(shader);
        Bitmap flat = Bitmap.createBitmap(OUT_W, OUT_H, Bitmap.Config.ARGB_8888);
        new Canvas(flat).drawRect(0, 0, OUT_W, OUT_H, p);
        return flat;
    }
}
