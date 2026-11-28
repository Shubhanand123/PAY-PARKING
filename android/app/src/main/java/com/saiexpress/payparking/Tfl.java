package com.saiexpress.payparking;

import android.content.Context;

import org.tensorflow.lite.Interpreter;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * TensorFlow Lite (LiteRT) for the on-device plate models. Replaces ONNX Runtime, which crashed natively
 * on the TVS i9200 POS at model load (3.16–3.19 check lines). TFLite picks CPU code paths at run time
 * from what the chip supports, so it runs on older and cheaper chips.
 */
final class Tfl {
    private Tfl() {}

    static Interpreter open(Context context, String asset) throws Exception {
        byte[] bytes;
        try (InputStream in = context.getAssets().open(asset); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            bytes = out.toByteArray();
        }
        ByteBuffer model = ByteBuffer.allocateDirect(bytes.length).order(ByteOrder.nativeOrder());
        model.put(bytes).rewind();
        Interpreter.Options o = new Interpreter.Options();
        o.setNumThreads(2);
        return new Interpreter(model, o);
    }

    /** Direct float buffer for an NHWC input of this many values. */
    static ByteBuffer floats(int n) { return ByteBuffer.allocateDirect(n * 4).order(ByteOrder.nativeOrder()); }
}
