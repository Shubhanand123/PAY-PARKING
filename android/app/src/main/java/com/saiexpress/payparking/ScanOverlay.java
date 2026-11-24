package com.saiexpress.payparking;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Guide, sweeping scan line, corners that close in when a plate is seen, and a green "got it" chip. */
final class ScanOverlay extends View {
    enum State { SEARCHING, FOUND, DONE }

    private static final int TEAL = Color.rgb(46, 230, 192);
    private static final int AMBER = Color.rgb(255, 204, 51);
    private static final int GREEN = Color.rgb(34, 197, 94);

    private final Paint dim = new Paint();
    private final Paint corner = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint chip = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint chipText = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint tick = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint small = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean hsrp;
    private final RectF guide = new RectF();
    private final float density;
    private float sweep; // 0..1 position of the scan line
    private float lock;  // 0..1 how far the corners have closed in
    private float pop;   // 0..1 success chip scale
    private State state = State.SEARCHING;
    private String plate = "";
    private final ValueAnimator sweeper;

    ScanOverlay(Context context) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        dim.setColor(Color.argb(110, 0, 0, 0));
        corner.setStyle(Paint.Style.STROKE);
        corner.setStrokeWidth(5 * density);
        corner.setStrokeCap(Paint.Cap.ROUND);
        chip.setColor(Color.WHITE);
        chipText.setColor(Color.rgb(17, 17, 17));
        chipText.setTextSize(26 * density);
        chipText.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        chipText.setTextAlign(Paint.Align.CENTER);
        chipText.setLetterSpacing(0.06f);
        small.setTextSize(10 * density);
        small.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        small.setTextAlign(Paint.Align.CENTER);
        small.setLetterSpacing(0.1f);
        border.setStyle(Paint.Style.STROKE);
        border.setStrokeWidth(3 * density);
        tick.setStyle(Paint.Style.STROKE);
        tick.setStrokeWidth(4 * density);
        tick.setStrokeCap(Paint.Cap.ROUND);
        tick.setColor(Color.WHITE);
        sweeper = ValueAnimator.ofFloat(0f, 1f);
        sweeper.setDuration(1500);
        sweeper.setRepeatMode(ValueAnimator.REVERSE);
        sweeper.setRepeatCount(ValueAnimator.INFINITE);
        sweeper.setInterpolator(new LinearInterpolator());
        sweeper.addUpdateListener(a -> { sweep = (float) a.getAnimatedValue(); invalidate(); });
    }

    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); sweeper.start(); }
    @Override protected void onDetachedFromWindow() { sweeper.cancel(); super.onDetachedFromWindow(); }

    /** Fraction of the view the guide covers; the activity uses the same box to prefer text inside it. */
    static final float SIDE = 0.06f, TOP = 0.30f, BOTTOM = 0.30f;

    /** At the exit, the read plate pops up as a number plate with the blue IND strip. */
    void setPlateStyle(boolean numberPlate) { hsrp = numberPlate; }

    void setState(State next, String plateText) {
        if (next == state && plateText.equals(plate)) return;
        state = next;
        plate = plateText;
        animateTo(next == State.SEARCHING ? 0f : 1f, v -> lock = v);
        if (next == State.DONE) animateTo(1f, v -> pop = v);
        else pop = 0f;
        invalidate();
    }

    private interface Setter { void set(float v); }
    private void animateTo(float target, Setter setter) {
        ValueAnimator a = ValueAnimator.ofFloat(target == 0f ? 1f : 0f, target);
        a.setDuration(320);
        a.addUpdateListener(x -> { setter.set((float) x.getAnimatedValue()); invalidate(); });
        a.start();
    }

    @Override protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        guide.set(w * SIDE, h * TOP, w * (1 - SIDE), h * (1 - BOTTOM));
        // dim everything outside the guide
        c.drawRect(0, 0, w, guide.top, dim);
        c.drawRect(0, guide.bottom, w, h, dim);
        c.drawRect(0, guide.top, guide.left, guide.bottom, dim);
        c.drawRect(guide.right, guide.top, w, guide.bottom, dim);

        int color = state == State.DONE ? GREEN : state == State.FOUND ? AMBER : TEAL;
        corner.setColor(color);
        // corners pull inward by up to 12% of the guide when a plate is in view
        float inX = guide.width() * 0.12f * lock, inY = guide.height() * 0.18f * lock;
        float l = guide.left + inX, r = guide.right - inX, t = guide.top + inY, b = guide.bottom - inY;
        float arm = 26 * density;
        drawCorner(c, l, t, arm, arm); drawCorner(c, r, t, -arm, arm);
        drawCorner(c, l, b, arm, -arm); drawCorner(c, r, b, -arm, -arm);

        if (state != State.DONE) {
            // a soft laser band sweeping up and down inside the guide
            float band = guide.height() * 0.24f;
            float top = guide.top + (guide.height() - band) * sweep;
            int glow = Color.argb(66, Color.red(color), Color.green(color), Color.blue(color));
            line.setShadowLayer(0, 0, 0, 0);
            line.setShader(new LinearGradient(0, top, 0, top + band,
                new int[] { Color.TRANSPARENT, glow, Color.argb(240, 230, 255, 250), Color.TRANSPARENT },
                new float[] { 0f, 0.82f, 0.97f, 1f }, Shader.TileMode.CLAMP));
            c.drawRect(guide.left, top, guide.right, top + band, line);
        }

        if (state == State.DONE && pop > 0) {
            float cx = w / 2, cy = guide.centerY();
            c.save();
            c.scale(0.6f + 0.4f * pop, 0.6f + 0.4f * pop, cx, cy);
            float strip = hsrp ? 22 * density : 0;
            float tw = chipText.measureText(plate) + 40 * density + strip, th = 52 * density;
            float left = cx - tw / 2, top = cy - th / 2 + 24 * density;
            chip.setColor(hsrp ? Color.rgb(251, 251, 247) : Color.WHITE);
            chip.setShadowLayer(16 * density, 0, 6 * density, Color.argb(120, 0, 0, 0));
            c.drawRoundRect(left, top, left + tw, top + th, 10 * density, 10 * density, chip);
            chip.setShadowLayer(0, 0, 0, 0);
            if (hsrp) {
                chip.setColor(Color.rgb(31, 79, 191));
                c.save();
                c.clipRect(left, top, left + strip, top + th);
                c.drawRoundRect(left, top, left + strip + 12 * density, top + th, 10 * density, 10 * density, chip);
                c.restore();
                small.setColor(Color.WHITE);
                c.save();
                c.rotate(-90, left + strip / 2, top + th / 2);
                c.drawText("IND", left + strip / 2, top + th / 2 + small.getTextSize() * 0.35f, small);
                c.restore();
            }
            border.setColor(Color.rgb(17, 17, 17));
            c.drawRoundRect(left, top, left + tw, top + th, 10 * density, 10 * density, border);
            c.drawText(plate, left + strip + (tw - strip) / 2, top + th / 2 + chipText.getTextSize() * 0.35f, chipText);
            // green tick badge above the chip
            float br = 24 * density, by = cy - 28 * density;
            chip.setShadowLayer(0, 0, 0, 0);
            chip.setColor(GREEN);
            c.drawCircle(cx, by, br, chip);
            Path p = new Path();
            p.moveTo(cx - 10 * density, by);
            p.lineTo(cx - 3 * density, by + 8 * density);
            p.lineTo(cx + 11 * density, by - 8 * density);
            c.drawPath(p, tick);
            c.restore();
        }
    }

    private void drawCorner(Canvas c, float x, float y, float dx, float dy) {
        c.drawLine(x, y, x + dx, y, corner);
        c.drawLine(x, y, x, y + dy, corner);
    }
}
