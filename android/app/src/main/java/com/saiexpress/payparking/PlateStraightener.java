package com.saiexpress.payparking;

import android.graphics.Bitmap;
import android.graphics.Matrix;

/**
 * Straightens a plate picture seen at an angle, before it is read.
 * Two measurements on the dark (letter) pixels, no model and no training:
 *  - tilt: the angle at which the letter rows are sharpest (rows of letters line up);
 *  - slant: the shear at which the letter strokes stand upright (seen from the side, letters lean).
 * Takes 1-3 ms on a 128 px wide copy. Returns the same picture when it is already straight.
 */
final class PlateStraightener {
    private PlateStraightener() {}

    static final class Result {
        final Bitmap picture; final float tiltDeg; final float slant;
        Result(Bitmap picture, float tiltDeg, float slant) { this.picture = picture; this.tiltDeg = tiltDeg; this.slant = slant; }
        boolean changed() { return Math.abs(tiltDeg) >= 3 || Math.abs(slant) >= 0.08f; }
    }

    static Result straighten(Bitmap band) {
        int w = 128, h = Math.max(16, Math.round(band.getHeight() * 128f / band.getWidth()));
        if (h > 160) h = 160;
        Bitmap small = Bitmap.createScaledBitmap(band, w, h, true);
        int[] px = new int[w * h];
        small.getPixels(px, 0, w, 0, 0, w, h);
        if (small != band) small.recycle();
        // Dark pixels = letters. Threshold at 85% of the mean brightness (plates are light with dark letters).
        int[] gray = new int[w * h]; long sum = 0;
        for (int i = 0; i < px.length; i++) { int p = px[i]; int g = (((p >> 16) & 255) * 3 + ((p >> 8) & 255) * 6 + (p & 255)) / 10; gray[i] = g; sum += g; }
        int cut = (int) (sum / px.length * 85 / 100);
        int n = 0; for (int g : gray) if (g < cut) n++;
        if (n < 40 || n > px.length * 0.6) return new Result(band, 0, 0); // nothing clear to measure
        float[] xs = new float[n], ys = new float[n]; int k = 0;
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) if (gray[y * w + x] < cut) { xs[k] = x - w / 2f; ys[k] = y - h / 2f; k++; }

        // 1. Tilt: try -20..20 degrees, keep the one where the row histogram is most uneven (letters in tight rows).
        float bestTilt = 0; double bestScore = -1;
        for (int d = -20; d <= 20; d += 2) {
            double a = Math.toRadians(d), s = Math.sin(a), c = Math.cos(a);
            double score = spread(xs, ys, n, s, c, h * 2, true);
            if (score > bestScore * 1.02 || (d == 0 && score >= bestScore * 0.98)) { bestScore = score; bestTilt = d; }
        }
        // 2. Slant: after removing the tilt, try shears -0.5..0.5; upright strokes make the column histogram most uneven.
        double a = Math.toRadians(bestTilt), s = Math.sin(a), c = Math.cos(a);
        float[] ux = new float[n], uy = new float[n];
        for (int i = 0; i < n; i++) { ux[i] = (float) (xs[i] * c + ys[i] * s); uy[i] = (float) (-xs[i] * s + ys[i] * c); }
        float bestSlant = 0; bestScore = -1;
        for (int t = -10; t <= 10; t++) {
            float sh = t * 0.05f;
            double score = shearSpread(ux, uy, n, sh, w * 2);
            if (score > bestScore * 1.02 || (t == 0 && score >= bestScore * 0.98)) { bestScore = score; bestSlant = sh; }
        }
        Result r = new Result(band, bestTilt, bestSlant);
        if (!r.changed()) return r;
        Matrix m = new Matrix();
        m.postTranslate(-band.getWidth() / 2f, -band.getHeight() / 2f);
        m.postRotate(-bestTilt);
        m.postSkew(bestSlant, 0);
        m.postTranslate(band.getWidth() / 2f, band.getHeight() / 2f);
        Bitmap out = Bitmap.createBitmap(band, 0, 0, band.getWidth(), band.getHeight(), m, true);
        return new Result(out, bestTilt, bestSlant);
    }

    /** Sum of squared bin counts of rotated y (rows): high when the letters sit in tight rows. */
    private static double spread(float[] xs, float[] ys, int n, double s, double c, int bins, boolean rows) {
        int[] hist = new int[bins]; int half = bins / 2;
        for (int i = 0; i < n; i++) {
            int b = (int) Math.round(-xs[i] * s + ys[i] * c) + half;
            if (b >= 0 && b < bins) hist[b]++;
        }
        double q = 0; for (int v : hist) q += (double) v * v; return q;
    }

    /** Sum of squared bin counts of sheared x (columns): high when strokes are upright. */
    private static double shearSpread(float[] xs, float[] ys, int n, float sh, int bins) {
        int[] hist = new int[bins]; int half = bins / 2;
        for (int i = 0; i < n; i++) {
            int b = Math.round(xs[i] + sh * ys[i]) + half;
            if (b >= 0 && b < bins) hist[b]++;
        }
        double q = 0; for (int v : hist) q += (double) v * v; return q;
    }
}
