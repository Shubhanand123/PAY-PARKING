package com.saiexpress.payparking;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.media.Image;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.SurfaceOrientedMeteringPointFactory;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen camera scanner. ML Kit reads text on every frame (on the device, offline);
 * PlateRules keeps only valid Indian plates; two agreeing frames make a read.
 * With "qr" set it also reads ticket QR codes.
 */
public class PlateScanActivity extends AppCompatActivity {
    static final String EXTRA_QR = "qr", EXTRA_TITLE = "title";
    static final String RESULT_PLATE = "plate", RESULT_ALTERNATIVES = "alternatives", RESULT_QR = "qr", RESULT_PICTURE = "picture";
    private volatile Bitmap lastPicture;

    /** The plate picture as a small JPEG (at most 320 px wide, ~10-20 KB), base64. Saved with the entry for training. */
    static String smallJpeg(Bitmap b) {
        if (b == null) return null;
        try {
            Bitmap s = b.getWidth() > 320 ? Bitmap.createScaledBitmap(b, 320, Math.max(1, Math.round(b.getHeight() * 320f / b.getWidth())), true) : b;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            s.compress(Bitmap.CompressFormat.JPEG, 75, out);
            return out.size() < 140_000 ? android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP) : null;
        } catch (Throwable e) { return null; }
    }

    private final ExecutorService analysis = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<String> recent = new ArrayDeque<>();
    private TextRecognizer text;
    private BarcodeScanner qr;
    private ScanOverlay overlay;
    private TextView status;
    private Button light;
    private Camera camera;
    private boolean torchOn, finished;
    private long lastSeen;

    // The text and QR readers are made once and kept, so the second scan onwards starts instantly.
    private static TextRecognizer sharedText;
    private static BarcodeScanner sharedQr;
    private static volatile ProcessCameraProvider cameraProvider; // the camera system, started when the app opens
    static synchronized TextRecognizer textReader() {
        if (sharedText == null) sharedText = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        return sharedText;
    }
    static synchronized BarcodeScanner qrReader() {
        if (sharedQr == null) sharedQr = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build());
        return sharedQr;
    }
    /** Loads the readers' models in the background when the app starts, so the first scan is fast too. */
    static void warmUp(android.content.Context context) {
        new Thread(() -> {
            try {
                Bitmap tiny = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888);
                InputImage img = InputImage.fromBitmap(tiny, 0);
                Tasks.await(textReader().process(img));
                Tasks.await(qrReader().process(img));
                cameraProvider = ProcessCameraProvider.getInstance(context.getApplicationContext()).get();
            } catch (Throwable ignored) { /* warming is only a speed-up */ }
        }).start();
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean readsQr = getIntent().getBooleanExtra(EXTRA_QR, false);
        PlateFinder.loadInBackground(this); // only when scanning: the app itself never depends on it
        PlateTextReader.loadInBackground(this);
        text = textReader();
        if (readsQr) qr = qrReader();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        // Nothing is shown until the camera's first picture is ready: the form stays on screen instead of a black screen.
        root.setAlpha(0f);
        PreviewView preview = new PreviewView(this);
        preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE); // fades in smoothly
        preview.getPreviewStreamState().observe(this, state -> { if (state == PreviewView.StreamState.STREAMING) reveal(root); });
        main.postDelayed(() -> reveal(root), 1500); // show the screen anyway if the camera is slow
        root.addView(preview, match());
        overlay = new ScanOverlay(this);
        overlay.setPlateStyle(readsQr); // the exit screen reads ticket QRs too
        root.addView(overlay, match());

        TextView title = label(getIntent().getStringExtra(EXTRA_TITLE) != null ? getIntent().getStringExtra(EXTRA_TITLE) : "Scan plate", 20, true);
        FrameLayout.LayoutParams top = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        title.setPadding(dp(20), dp(28), dp(20), dp(8));
        root.addView(title, top);

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setPadding(dp(16), dp(12), dp(16), dp(24));
        status = label(readsQr ? "Point at the ticket QR or the number plate" : "Keep the whole plate inside the frame", 16, false);
        status.setGravity(Gravity.CENTER);
        bottom.addView(status);
        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER);
        buttons.setPadding(0, dp(12), 0, 0);
        light = button("Light off");
        light.setVisibility(View.GONE);
        light.setOnClickListener(v -> toggleTorch());
        Button manual = button("Type manually");
        manual.setOnClickListener(v -> cancel());
        buttons.addView(light);
        buttons.addView(manual);
        bottom.addView(buttons);
        root.addView(bottom, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
        setContentView(root);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { cancel(); }
        });
        startCamera(preview);
    }

    private void startCamera(PreviewView preview) {
        if (cameraProvider != null) { bind(cameraProvider, preview); return; } // ready since app start: open at once
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try { cameraProvider = future.get(); bind(cameraProvider, preview); }
            catch (Exception e) { status.setText("The camera could not start. Tap Type manually."); }
        }, getMainExecutor());
    }

    private void bind(ProcessCameraProvider provider, PreviewView preview) {
        try {
            Preview use = new Preview.Builder().build();
            use.setSurfaceProvider(preview.getSurfaceProvider());
            ResolutionSelector resolution = new ResolutionSelector.Builder()
                .setResolutionStrategy(new ResolutionStrategy(new Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build();
            ImageAnalysis frames = new ImageAnalysis.Builder()
                .setResolutionSelector(resolution)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .build();
            frames.setAnalyzer(analysis, this::analyze);
            provider.unbindAll();
            camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, use, frames);
            if (camera.getCameraInfo().hasFlashUnit()) light.setVisibility(View.VISIBLE);
            // Focus and expose for the middle (where the plate is), then go back to continuous focus.
            // Refocused every 3 s while no plate is found, and on a tap anywhere on the picture.
            focusAt(preview, 0.5f, 0.5f);
            main.postDelayed(refocus = () -> {
                if (finished) return;
                if (System.currentTimeMillis() - lastSeen > 2500) focusAt(preview, 0.5f, 0.5f);
                main.postDelayed(refocus, 3000);
            }, 3000);
            preview.setOnTouchListener((v, e) -> {
                if (e.getAction() == android.view.MotionEvent.ACTION_UP) focusAt(preview, e.getX() / v.getWidth(), e.getY() / v.getHeight());
                return true;
            });
        } catch (Exception e) {
            status.setText("The camera could not start. Tap Type manually.");
        }
    }

    /** The band of the picture that is read for text: the middle half, where the on-screen frame is. Reading less is faster. */
    private static final float BAND_TOP = 0.16f, BAND_BOTTOM = 0.84f; // generous: the plate is caught even when not centred

    private void analyze(ImageProxy frame) {
        if (finished) { frame.close(); return; }
        Bitmap upright;
        try {
            Bitmap raw = frame.toBitmap();
            int rotation = frame.getImageInfo().getRotationDegrees();
            if (rotation != 0) {
                Matrix m = new Matrix(); m.postRotate(rotation);
                upright = Bitmap.createBitmap(raw, 0, 0, raw.getWidth(), raw.getHeight(), m, false);
            } else upright = raw;
        } catch (Throwable e) {
            frame.close(); return;
        }
        frame.close(); // free the camera straight away for the next picture
        // 1. The plate finder boxes the plate (tens of ms); 2. the text reader reads only that box.
        // No box found: read the middle band of the picture, as before.
        Bitmap band = null;
        long t0 = System.nanoTime();
        PlateFinder finder = PlateFinder.ready(); // not loaded yet: read the old way for these first frames
        if (finder != null) {
            try {
                android.graphics.Rect box = finder.find(upright);
                if (box != null) {
                    int mx = Math.round(box.width() * 0.12f), my = Math.round(box.height() * 0.35f);
                    int x1 = Math.max(0, box.left - mx), y1 = Math.max(0, box.top - my);
                    int x2 = Math.min(upright.getWidth(), box.right + mx), y2 = Math.min(upright.getHeight(), box.bottom + my);
                    if (x2 - x1 > 16 && y2 - y1 > 8) {
                        band = Bitmap.createBitmap(upright, x1, y1, x2 - x1, y2 - y1);
                        // Small, far-away plates: enlarge so every letter has enough pixels to read.
                        if (band.getHeight() < 96) {
                            float k = 96f / band.getHeight();
                            band = Bitmap.createScaledBitmap(band, Math.round(band.getWidth() * k), 96, true);
                        }
                    }
                }
            } catch (Throwable e) { band = null; }
        }
        finderMs = (System.nanoTime() - t0) / 1_000_000;
        boolean boxed = band != null;
        if (band == null) {
            int top = Math.round(upright.getHeight() * BAND_TOP), bandH = Math.round(upright.getHeight() * (BAND_BOTTOM - BAND_TOP));
            band = Bitmap.createBitmap(upright, 0, top, upright.getWidth(), bandH);
        }
        // Our Indian plate reader on the plate box (about 10 ms). A sure reading of a valid plate is taken at once;
        // anything less sure goes to ML Kit as before.
        PlateTextReader ours = boxed ? PlateTextReader.ready() : null;
        if (ours != null) {
            try {
                long tr = System.nanoTime();
                PlateTextReader.Reading rd = ours.read(band);
                readerMs = (System.nanoTime() - tr) / 1_000_000;
                String plate = PlateRules.directFromLines(java.util.Collections.singletonList(rd.text));
                if (plate != null && rd.confidence >= 0.9f) {
                    final Bitmap seen = band;
                    lastBoxed = true; ownReader = true;
                    main.post(() -> { if (!finished) { lastPicture = seen; finishWith(plate, new ArrayList<>(), null); } });
                    return;
                }
            } catch (Throwable ignored) { /* fall back to ML Kit */ }
        }
        ownReader = false;
        int width = band.getWidth(), height = band.getHeight();
        final boolean usedFinder = boxed;
        long t1 = System.nanoTime();
        Task<Text> reading = text.process(InputImage.fromBitmap(band, 0));
        Task<List<Barcode>> codes = qr != null ? qr.process(InputImage.fromBitmap(upright, 0)) : Tasks.forResult(Collections.emptyList());
        try { Tasks.await(Tasks.whenAllComplete(reading, codes)); } catch (Exception ignored) { /* handled below */ }
        readerMs = (System.nanoTime() - t1) / 1_000_000;
        lastBoxed = usedFinder;
        final Bitmap readFrom = band;
        main.post(() -> {
            if (finished) return;
            if (codes.isSuccessful()) for (Barcode code : codes.getResult()) {
                if (code.getRawValue() != null) { finishWith(null, null, code.getRawValue()); return; }
            }
            lastPicture = readFrom; // the picture this reading came from (kept for training the plate reader)
            if (reading.isSuccessful()) onText(reading.getResult(), width, height);
        });
    }

    /** Keeps the valid plate nearest the middle of the frame, then votes across recent frames. */
    private void onText(Text result, int width, int height) {
        String best = null;
        boolean bestClear = false;
        double bestDistance = Double.MAX_VALUE;
        for (Text.TextBlock block : result.getTextBlocks()) {
            List<String> lines = new ArrayList<>();
            float confidence = 1f;
            for (Text.Line line : block.getLines()) { lines.add(line.getText()); confidence = Math.min(confidence, line.getConfidence()); }
            String plate = PlateRules.fromLines(lines);
            Rect box = block.getBoundingBox();
            if (plate == null || box == null) continue;
            double dx = box.exactCenterX() / width - 0.5, dy = box.exactCenterY() / height - 0.5;
            double distance = dx * dx + dy * dy;
            if (distance < bestDistance) {
                bestDistance = distance; best = plate;
                // Read cleanly in one go: valid as read (no look-alike fixes) and the reader is sure of every letter.
                bestClear = confidence >= 0.7f && plate.equals(PlateRules.directFromLines(lines));
            }
        }
        final String clear = best;
        if (clear != null && bestClear && recent.stream().noneMatch(p -> !p.isEmpty() && !p.equals(clear))) {
            finishWith(clear, new ArrayList<>(), null); // one clear frame is enough: no waiting for a second
            return;
        }
        recent.addLast(best == null ? "" : best);
        while (recent.size() > 5) recent.removeFirst();

        Map<String, Integer> votes = new HashMap<>();
        for (String p : recent) if (!p.isEmpty()) votes.merge(p, 1, Integer::sum);
        String top = null;
        int topCount = 0, second = 0;
        for (Map.Entry<String, Integer> e : votes.entrySet()) {
            if (e.getValue() > topCount) { second = topCount; topCount = e.getValue(); top = e.getKey(); }
            else if (e.getValue() > second) second = e.getValue();
        }
        if (best != null) lastSeen = System.currentTimeMillis();
        if (top != null && topCount >= 2 && topCount > second * 2) {
            List<String> others = new ArrayList<>();
            for (String p : votes.keySet()) if (!p.equals(top)) others.add(p);
            finishWith(top, others, null);
        } else if (best != null) {
            overlay.setState(ScanOverlay.State.FOUND, "");
            status.setText("Plate found. Hold steady…");
        } else if (System.currentTimeMillis() - lastSeen > 1500) {
            overlay.setState(ScanOverlay.State.SEARCHING, "");
            status.setText(qr != null ? "Point at the ticket QR or the number plate" : "Keep the whole plate inside the frame");
        }
    }

    private void finishWith(String plate, List<String> alternatives, String qrValue) {
        finished = true;
        // a light buzz so the operator feels the read without looking; needs no extra permission
        overlay.performHapticFeedback(android.os.Build.VERSION.SDK_INT >= 30 ? android.view.HapticFeedbackConstants.CONFIRM : android.view.HapticFeedbackConstants.VIRTUAL_KEY);
        Intent data = new Intent();
        if (qrValue != null) {
            data.putExtra(RESULT_QR, qrValue);
            setResult(RESULT_OK, data);
            finish();
            return;
        }
        data.putExtra(RESULT_PLATE, plate);
        data.putExtra(RESULT_ALTERNATIVES, alternatives.toArray(new String[0]));
        String picture = smallJpeg(lastPicture);
        if (picture != null) data.putExtra(RESULT_PICTURE, picture);
        setResult(RESULT_OK, data);
        overlay.setState(ScanOverlay.State.DONE, pretty(plate));
        // Timing line, so the speed can be checked at the gate.
        PlateFinder f = PlateFinder.ready();
        String took = shownAt > 0 ? String.format(java.util.Locale.ROOT, "%.1f s", (System.currentTimeMillis() - shownAt) / 1000f) : "";
        status.setText("Got it" + (took.isEmpty() ? "" : " in " + took) + (lastBoxed && f != null ? " · plate box " + finderMs + " ms (" + f.engine + ") + " + (ownReader ? "Indian reader " : "read ") + readerMs + " ms" : " · read " + readerMs + " ms"));
        main.postDelayed(this::finish, 500); // long enough to see the plate and the timing line // a short "got it" moment, then back to the form
    }

    private void cancel() {
        finished = true;
        setResult(RESULT_CANCELED);
        finish();
    }

    private void toggleTorch() {
        if (camera == null) return;
        torchOn = !torchOn;
        camera.getCameraControl().enableTorch(torchOn);
        light.setText(torchOn ? "Light on" : "Light off");
    }

    private Runnable refocus;
    private volatile long finderMs, readerMs;
    private volatile boolean lastBoxed, ownReader;
    private long shownAt;
    private void focusAt(PreviewView preview, float x, float y) {
        if (camera == null) return;
        try {
            camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(
                new SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(x, y))
                .setAutoCancelDuration(2, java.util.concurrent.TimeUnit.SECONDS).build());
        } catch (Throwable ignored) { /* the camera keeps its own focus */ }
    }

    private boolean shown;
    private void reveal(View root) {
        if (shown) return;
        shown = true;
        root.animate().alpha(1f).setDuration(120).start();
        shownAt = System.currentTimeMillis();
    }

    @Override public void finish() {
        super.finish();
        overridePendingTransition(0, 0); // straight back to the form, no slide
    }

    @Override protected void onDestroy() {
        analysis.shutdown(); // the shared readers stay loaded for the next scan
        super.onDestroy();
    }

    /** GA07AB1234 -> GA 07 AB 1234 for display. */
    static String pretty(String p) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^([A-Z]{2})(\\d{1,2})([A-Z]{0,3})(\\d{4})$").matcher(p);
        if (!m.matches()) return p;
        StringBuilder s = new StringBuilder(m.group(1)).append(' ').append(m.group(2));
        if (!m.group(3).isEmpty()) s.append(' ').append(m.group(3));
        return s.append(' ').append(m.group(4)).toString();
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private TextView label(String value, int sp, boolean bold) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextColor(Color.WHITE);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setShadowLayer(6, 0, 1, Color.BLACK);
        return v;
    }

    private Button button(String value) {
        Button b = new Button(this);
        b.setText(value);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(52), 1f);
        lp.setMargins(dp(6), 0, dp(6), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
