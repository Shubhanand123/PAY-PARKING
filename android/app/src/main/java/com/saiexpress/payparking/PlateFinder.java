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
import java.util.EnumSet;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.providers.NNAPIFlags;

/**
 * Finds the number plate in a camera picture (YOLOv9-tiny, 256 x 256, trained on plates; MIT, open-image-models).
 * Runs on the phone's AI chip (NNAPI) when it has one, otherwise on all CPU cores.
 * Returns the plate box in the picture's own pixels, so the text reader only has to read that small box.
 */
final class PlateFinder {
    private static final String TAG = "PlateFinder";
    private static final int SIZE = 256;
    private static final float MIN_SCORE = 0.3f;

    private static PlateFinder shared;
    private static boolean failed, cpuOnly;
    private int errors;

    private final OrtEnvironment env;
    private final OrtSession session;
    private final String inputName;
    final String engine; // "AI chip" or "CPU", shown in the timing line
    private final Bitmap board = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
    private final Canvas canvas = new Canvas(board);
    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
    private final int[] pixels = new int[SIZE * SIZE];
    private final FloatBuffer input = FloatBuffer.allocate(3 * SIZE * SIZE);

    /** The shared finder, loaded once (at app start by warmUp). Null if the model can't run on this phone. */
    static synchronized PlateFinder get(Context context) {
        if (shared == null && !failed) {
            try { shared = new PlateFinder(context.getApplicationContext()); }
            catch (Throwable e) { failed = true; Log.w(TAG, "Plate finder unavailable: " + e); }
        }
        return shared;
    }

    private PlateFinder(Context context) throws Exception {
        byte[] model = read(context, "models/plate_finder_256.onnx");
        env = OrtEnvironment.getEnvironment();
        OrtSession s = null;
        String used = "CPU";
        if (!cpuOnly) try {
            OrtSession.SessionOptions ai = new OrtSession.SessionOptions();
            ai.addNnapi(EnumSet.of(NNAPIFlags.USE_FP16));
            s = env.createSession(model, ai);
            used = "AI chip";
        } catch (Throwable e) {
            Log.i(TAG, "No AI chip support, using the CPU: " + e);
        }
        if (s == null) {
            OrtSession.SessionOptions cpu = new OrtSession.SessionOptions();
            cpu.setIntraOpNumThreads(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())));
            cpu.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            s = env.createSession(model, cpu);
        }
        session = s;
        engine = used;
        inputName = session.getInputNames().iterator().next();
        find(Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)); // first run is slow: do it now, not on the first vehicle
    }

    private static byte[] read(Context context, String asset) throws Exception {
        try (InputStream in = context.getAssets().open(asset); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /** Runs the model. If the AI chip keeps failing on this phone, switch to the CPU for the rest of the session. */
    private OrtSession.Result run(OnnxTensor tensor) throws Exception {
        try { return session.run(Collections.singletonMap(inputName, tensor)); }
        catch (Exception e) {
            if (++errors >= 3 && "AI chip".equals(engine)) {
                Log.w(TAG, "AI chip failed, switching to the CPU: " + e);
                synchronized (PlateFinder.class) { cpuOnly = true; shared = null; }
            }
            throw e;
        }
    }

    /** The plate box nearest the middle of the picture, or null. */
    synchronized Rect find(Bitmap picture) throws Exception {
        int w = picture.getWidth(), h = picture.getHeight();
        // Letterbox: keep the shape, pad with grey (as the model was trained).
        float r = Math.min((float) SIZE / w, (float) SIZE / h);
        float nw = w * r, nh = h * r, dx = (SIZE - nw) / 2f, dy = (SIZE - nh) / 2f;
        canvas.drawColor(Color.rgb(114, 114, 114));
        canvas.drawBitmap(picture, null, new RectF(dx, dy, dx + nw, dy + nh), paint);
        board.getPixels(pixels, 0, SIZE, 0, 0, SIZE, SIZE);
        input.clear();
        float[] data = input.array();
        int plane = SIZE * SIZE;
        for (int i = 0; i < plane; i++) {
            int p = pixels[i];
            data[i] = ((p >> 16) & 0xff) / 255f;
            data[plane + i] = ((p >> 8) & 0xff) / 255f;
            data[2 * plane + i] = (p & 0xff) / 255f;
        }
        try (OnnxTensor tensor = OnnxTensor.createTensor(env, input, new long[] { 1, 3, SIZE, SIZE });
             OrtSession.Result out = run(tensor)) {
            float[][] rows = (float[][]) out.get(0).getValue(); // [batch, x1, y1, x2, y2, class, score]
            Rect best = null;
            double bestScore = -1;
            for (float[] row : rows) {
                if (row.length < 7 || row[6] < MIN_SCORE) continue;
                float x1 = (row[1] - dx) / r, y1 = (row[2] - dy) / r, x2 = (row[3] - dx) / r, y2 = (row[4] - dy) / r;
                double cx = (x1 + x2) / 2 / w - 0.5, cy = (y1 + y2) / 2 / h - 0.5;
                double score = row[6] - (cx * cx + cy * cy); // sure, and near the middle
                if (score > bestScore) { bestScore = score; best = new Rect(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)); }
            }
            return best;
        }
    }
}
