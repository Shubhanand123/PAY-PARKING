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

    /** The plate picture as a very small JPEG (at most 256 px wide, quality 60: about 3-8 KB), base64. Saved for training. */
    static String smallJpeg(Bitmap b) {
        if (b == null) return null;
        try {
            Bitmap s = b.getWidth() > 256 ? Bitmap.createScaledBitmap(b, 256, Math.max(1, Math.round(b.getHeight() * 256f / b.getWidth())), true) : b;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            s.compress(Bitmap.CompressFormat.JPEG, 60, out);
            return out.size() < 60_000 ? android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP) : null;
        } catch (Throwable e) { return null; }
    }

    private final ExecutorService analysis = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<String> recent = new ArrayDeque<>();
    private TextRecognizer text;
    private BarcodeScanner qr;
    private ScanOverlay overlay;
    private TextView status, diag;
    private String lastExit = "";
    private Runnable diagTick;
    private volatile int boxSeen; private volatile String bestText; private volatile float bestConf;
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
        // Only when scanning, one model after the other (never all at once): if one crashes on this POS,
        // only that one is switched off next time and the others still load.
        final android.content.Context app = getApplicationContext();
        new Thread(() -> { PlateTextReader.get(app); PlateFinder.get(app); PlateCorners.get(app); }, "plate-models-load").start();
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
        // Live check line: where the time goes while scanning (frames/s, plate box found, best reading so far).
        lastExit = ModelGuard.lastExit(this);
        diag = new TextView(this);
        diag.setTextColor(0xCCFFFFFF);
        diag.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        diag.setGravity(Gravity.CENTER);
        diag.setPadding(0, dp(4), 0, 0);
        bottom.addView(diag);
        main.postDelayed(diagTick = () -> {
            if (finished) return;
            long ms = shownAt > 0 ? System.currentTimeMillis() - shownAt : 0;
            float fps = ms > 0 ? framesSeen * 1000f / ms : 0;
            String models = android.os.Build.SUPPORTED_ABIS[0] + (lastExit.isEmpty() ? "" : " · " + lastExit) + " · finder " + PlateFinder.GUARD.state + " · reader " + PlateTextReader.GUARD.state + " · corners " + PlateCorners.GUARD.state;
            diag.setText(String.format(java.util.Locale.ROOT, "%.1f s · %.0f fps · %s · plate box %s (%d ms)%s",
                ms / 1000f, fps, models, boxSeen > 0 ? "seen " + boxSeen + "×" : "not seen", finderMs,
                bestText != null ? String.format(java.util.Locale.ROOT, " · best %s %.0f%%", bestText, bestConf * 100) : ""));
            main.postDelayed(diagTick, 400);
        }, 400);
        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER);
        buttons.setPadding(0, dp(12), 0, 0);
        light = button("Light off");
        light.setVisibility(View.GONE);
        light.setOnClickListener(v -> { torchByHand = true; toggleTorch(); });
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
            ImageAnalysis.Builder framesBuilder = new ImageAnalysis.Builder()
                .setResolutionSelector(resolution);
            // Hand shake: keep the camera at 30 frames a second, so each picture is exposed for at most 1/30 s
            // (in dim light phones otherwise slow down to 1/15 s or longer, and a moving hand smears the letters).
            try {
                new androidx.camera.camera2.interop.Camera2Interop.Extender<>(framesBuilder)
                    .setCaptureRequestOption(android.hardware.camera2.CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, new android.util.Range<>(30, 30));
            } catch (Throwable ignored) { /* camera keeps its own setting */ }
            ImageAnalysis frames = framesBuilder
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

    // Frames are handled as fast as the plate finder runs. ML Kit (slow) works on one frame at a time in the
    // background; while it is busy, newer frames still go through the finder and the Indian reader.
    private final java.util.concurrent.atomic.AtomicBoolean mlKitBusy = new java.util.concurrent.atomic.AtomicBoolean(false);
    private volatile int framesSeen;

    /** A rectangle in the upright picture, as the same rectangle in the camera's raw (not yet rotated) picture. */
    private static Rect toRaw(Rect u, int rotation, int rawW, int rawH) {
        switch (rotation) {
            case 90: return new Rect(u.top, rawH - u.right, u.bottom, rawH - u.left);
            case 180: return new Rect(rawW - u.right, rawH - u.bottom, rawW - u.left, rawH - u.top);
            case 270: return new Rect(rawW - u.bottom, u.left, rawW - u.top, u.right);
            default: return new Rect(u);
        }
    }

    /** Cuts the upright rectangle out of the raw picture and turns only that small piece upright. */
    private Rect lastBox; private long lastBoxAt; private volatile boolean straightened, lastVoted;
    /** One frame's reading, kept for 1.5 s for the moving-vehicle rules (sharpest frame / letter vote). */
    private static final class Seen { final long at; final PlateTextReader.Reading reading; final Bitmap picture;
        Seen(long at, PlateTextReader.Reading r, Bitmap p) { this.at = at; reading = r; picture = p; } }
    private final List<Seen> window = new ArrayList<>(); // used on the frame thread only

    private static Bitmap cutUpright(Bitmap raw, Rect upright, int rotation) {
        Rect r = toRaw(upright, rotation, raw.getWidth(), raw.getHeight());
        r.intersect(0, 0, raw.getWidth(), raw.getHeight());
        if (r.width() < 2 || r.height() < 2) return null;
        Matrix m = new Matrix(); m.postRotate(rotation);
        return Bitmap.createBitmap(raw, r.left, r.top, r.width(), r.height(), m, true);
    }

    private void analyze(ImageProxy frame) {
        if (finished) { frame.close(); return; }
        Bitmap raw;
        int rotation;
        try {
            raw = frame.toBitmap();
            rotation = frame.getImageInfo().getRotationDegrees();
        } catch (Throwable e) {
            frame.close(); return;
        }
        frame.close(); // free the camera straight away for the next picture
        autoLight(raw);
        framesSeen++;
        boolean sideways = rotation == 90 || rotation == 270;
        int uw = sideways ? raw.getHeight() : raw.getWidth(), uh = sideways ? raw.getWidth() : raw.getHeight();
        // 1. The plate finder boxes the plate; 2. only that box is turned upright and read.
        Bitmap band = null;
        long t0 = System.nanoTime();
        PlateFinder finder = PlateFinder.ready(); // not loaded yet: read the old way for these first frames
        if (finder != null) {
            try {
                // The finder runs on every 2nd frame; between, the last box (under 0.2 s old) is reused, grown a bit more.
                boolean reuse = false; // 3.21: with ML Kit text off, the finder runs on every frame (the plate is found sooner)
                Rect box = reuse ? lastBox : finder.find(raw, rotation);
                if (!reuse) { lastBox = box; lastBoxAt = System.currentTimeMillis(); }
                if (box != null && !reuse) focusOnPlate(box, rotation, raw.getWidth(), raw.getHeight());
                if (box != null) {
                    int mx = Math.round(box.width() * 0.12f), my = Math.round(box.height() * 0.35f);
                    Rect grown = new Rect(Math.max(0, box.left - mx), Math.max(0, box.top - my), Math.min(uw, box.right + mx), Math.min(uh, box.bottom + my));
                    if (grown.width() > 16 && grown.height() > 8) {
                        band = cutUpright(raw, grown, rotation);
                        // Small, far-away plates: enlarge so every letter has enough pixels to read.
                        if (band != null && band.getHeight() < 96) {
                            float k = 96f / band.getHeight();
                            band = Bitmap.createScaledBitmap(band, Math.round(band.getWidth() * k), 96, true);
                        }
                    }
                }
            } catch (Throwable e) { band = null; }
        }
        finderMs = (System.nanoTime() - t0) / 1_000_000;
        boolean boxed = band != null;
        if (boxed) boxSeen++;
        if (!boxed) window.clear(); // no plate in view: the next vehicle starts a new window
        // Our Indian plate reader on the plate box (a few ms). A sure reading of a valid plate is taken at once.
        PlateTextReader ours = boxed ? PlateTextReader.ready() : null;
        if (ours != null) {
            try {
                long tr = System.nanoTime();
                PlateTextReader.Reading rd;
                boolean turned = false;
                String plate;
                PlateCorners corners = PlateCorners.ready();
                if (corners != null) {
                    // 4-corner model: the plate's corners in the box, warped flat (also side angles), then read.
                    // Tested on the 163 test plates (whole chain): exact 81.8% straight / 76.0% turned 20-50 deg,
                    // was 72.7% / 60.4% with the old finder and tilt/lean straightening.
                    rd = ours.read(corners.flatten(band)); turned = true;
                    plate = PlateRules.directFromLines(java.util.Collections.singletonList(rd.text));
                } else {
                    rd = ours.read(band);
                    plate = PlateRules.directFromLines(java.util.Collections.singletonList(rd.text));
                }
                if (rd.text != null && !rd.text.isEmpty() && rd.confidence > bestConf) { bestConf = rd.confidence; bestText = rd.text; }
                // Not sure yet (often a side angle): straighten the plate (tilt + lean) and read it again; keep the surer reading.
                if (corners == null && (plate == null || rd.confidence < 0.95f)) {
                    PlateStraightener.Result st = PlateStraightener.straighten(band);
                    if (st.changed()) {
                        PlateTextReader.Reading rd2 = ours.read(st.picture);
                        String plate2 = PlateRules.directFromLines(java.util.Collections.singletonList(rd2.text));
                        if (plate2 != null && (plate == null || rd2.confidence > rd.confidence)) { rd = rd2; plate = plate2; band = st.picture; turned = true; }
                    }
                }
                long took = (System.nanoTime() - tr) / 1_000_000;
                // Moving vehicles (3.13): the readings of the last 1.5 s are kept. Taken: the sharpest frame's reading if it is
                // 95%+ sure, else the letter-by-letter vote of the frames at least half as sharp as the sharpest (2+ frames) if 85%+ sure.
                // Tested on the 163 test plates with motion blur (training/scripts/vote_sim.py): filled in 71% of plates
                // with 2 wrong, against 56% with 2 wrong when one frame decides.
                long now = System.currentTimeMillis();
                window.removeIf(x -> now - x.at > 1500);
                window.add(new Seen(now, rd, band));
                if (window.size() > 4) window.remove(0);
                Seen sharpest = window.get(0);
                for (Seen x : window) if (x.reading.sharpness > sharpest.reading.sharpness) sharpest = x;
                String got = null; Bitmap from = band; boolean voted = false;
                String p1 = PlateRules.directFromLines(java.util.Collections.singletonList(sharpest.reading.text));
                if (p1 != null && sharpest.reading.confidence >= 0.85f) { got = p1; from = sharpest.picture; } // 3.22: owner chose speed over a little accuracy (was 0.95)
                else {
                    List<PlateTextReader.Reading> use = new ArrayList<>();
                    for (Seen x : window) if (x.reading.sharpness >= 0.5f * sharpest.reading.sharpness) use.add(x.reading);
                    if (use.size() >= 2) {
                        PlateTextReader.Reading v = PlateTextReader.vote(use);
                        String p2 = PlateRules.directFromLines(java.util.Collections.singletonList(v.text));
                        if (p2 != null && v.confidence >= 0.75f) { got = p2; from = sharpest.picture; voted = true; } // 3.22: was 0.85
                    }
                }
                if (got != null) {
                    window.clear(); lastVoted = voted;
                    final Bitmap seen = from; final boolean wasTurned = turned; final String plateGot = got;
                    main.post(() -> { if (!finished) { readerMs = took; lastBoxed = true; ownReader = true; straightened = wasTurned; lastPicture = seen; finishWith(plateGot, new ArrayList<>(), null); } });
                    return;
                }
            } catch (Throwable ignored) { /* ML Kit below */ }
        }
        // ML Kit (and the ticket QR on the exit gate): only if it is not still busy with an earlier frame.
        if (!mlKitBusy.compareAndSet(false, true)) return;
        if (band == null) band = cutUpright(raw, new Rect(0, Math.round(uh * BAND_TOP), uw, Math.round(uh * BAND_BOTTOM)), rotation);
        if (band == null) { mlKitBusy.set(false); return; }
        final Bitmap readFrom = band;
        final int width = band.getWidth(), height = band.getHeight();
        final boolean usedFinder = boxed;
        final long t1 = System.nanoTime();
        // Speed: when our own models run, the slow ML Kit text reader (~2 s per picture on the POS, and it eats the CPU
        // our models need) is skipped; it only helps when our models are off or nothing was read for 4 s.
        boolean oursOk = PlateFinder.ready() != null && PlateTextReader.ready() != null;
        boolean useMlText = !oursOk || (shownAt > 0 && System.currentTimeMillis() - shownAt > 4000);
        Task<Text> reading = useMlText ? text.process(InputImage.fromBitmap(band, 0)) : Tasks.forException(new Exception("skipped"));
        Task<List<Barcode>> codes = qr != null ? qr.process(InputImage.fromBitmap(raw, rotation)) : Tasks.forResult(Collections.emptyList());
        Tasks.whenAllComplete(reading, codes).addOnCompleteListener(main::post, done -> {
            mlKitBusy.set(false);
            if (finished) return;
            if (codes.isSuccessful()) for (Barcode code : codes.getResult()) {
                if (code.getRawValue() != null) { finishWith(null, null, code.getRawValue()); return; }
            }
            readerMs = (System.nanoTime() - t1) / 1_000_000;
            lastBoxed = usedFinder; ownReader = false;
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
        float fps = shownAt > 0 ? framesSeen * 1000f / Math.max(1, System.currentTimeMillis() - shownAt) : 0;
        status.setText("Got it" + (took.isEmpty() ? "" : " in " + took) + String.format(java.util.Locale.ROOT, " · %.0f frames/s", fps) + (lastBoxed && f != null ? " · plate box " + finderMs + " ms (" + f.engine + ") + " + (ownReader ? "Indian reader" + (straightened ? " (straightened)" : "") + (lastVoted ? " (frames voted)" : "") + " " : "read ") + readerMs + " ms" : " · read " + readerMs + " ms"));
        main.postDelayed(this::finish, 200); // long enough to see the plate and the timing line // a short "got it" moment, then back to the form
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

    // Auto focus on the plate: when the finder boxes a plate, focus and expose on that box (at most every 1.2 s,
    // and only when the plate moved), instead of the middle of the picture.
    private volatile long plateFocusAt; private volatile float lastFx = -1, lastFy = -1;
    private void focusOnPlate(Rect upright, int rotation, int rawW, int rawH) {
        long now = System.currentTimeMillis();
        if (camera == null || now - plateFocusAt < 1200) return;
        Rect r = toRaw(upright, rotation, rawW, rawH);
        float fx = r.exactCenterX() / rawW, fy = r.exactCenterY() / rawH;
        if (Math.abs(fx - lastFx) < 0.05f && Math.abs(fy - lastFy) < 0.05f && now - plateFocusAt < 4000) return; // same spot, still sharp
        plateFocusAt = now; lastFx = fx; lastFy = fy;
        float size = Math.min(0.5f, Math.max(0.08f, Math.max(r.width() / (float) rawW, r.height() / (float) rawH)));
        try {
            camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(
                new SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(Math.max(0f, Math.min(1f, fx)), Math.max(0f, Math.min(1f, fy)), size))
                .setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS).build());
        } catch (Throwable ignored) { /* the camera keeps its own focus */ }
    }

    // Auto light: if the picture stays dark for 1.5 s, the torch turns on by itself (once; the Light button still works).
    private volatile long darkSince; private volatile boolean autoLightDone, torchByHand;
    private void autoLight(Bitmap raw) {
        if (autoLightDone || torchByHand || camera == null || !camera.getCameraInfo().hasFlashUnit()) return;
        int w = raw.getWidth(), h = raw.getHeight(); long sum = 0; int n = 0;
        for (int y = h / 4; y < h * 3 / 4; y += Math.max(1, h / 16)) for (int x = w / 4; x < w * 3 / 4; x += Math.max(1, w / 16)) {
            int p = raw.getPixel(x, y); sum += ((p >> 16) & 255) * 3 + ((p >> 8) & 255) * 6 + (p & 255); n++;
        }
        float mean = n == 0 ? 255 : sum / (10f * n);
        long now = System.currentTimeMillis();
        if (mean >= 45) { darkSince = 0; return; }
        if (darkSince == 0) { darkSince = now; return; }
        if (now - darkSince > 1500) {
            autoLightDone = true;
            main.post(() -> { if (!torchOn && !finished) toggleTorch(); });
        }
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
