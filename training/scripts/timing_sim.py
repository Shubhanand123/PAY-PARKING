import sys, time, random, math, csv, cv2, numpy as np
sys.argv = [sys.argv[0], sys.argv[1]]
src = open('scripts/straight_test.py').read(); src = src[:src.index('rows = list(csv.DictReader')]
exec(src)
rows = list(csv.DictReader(open(os.path.join(D, 'test.csv')))); random.seed(7)
def warp(im):
    H, W = im.shape[:2]; sh = random.choice([-1, 1]) * random.uniform(.15, .35); tilt = random.uniform(-10, 10); s_ = random.uniform(.1, .25)
    src_ = np.float32([[0, 0], [W, 0], [W, H], [0, H]]); dst = src_.copy(); dst[1, 1] += s_ * H / 2; dst[2, 1] -= s_ * H / 2
    w1 = cv2.warpPerspective(im, cv2.getPerspectiveTransform(src_, dst), (W, H), borderMode=cv2.BORDER_REPLICATE)
    w1 = cv2.warpAffine(w1, np.array([[1, sh, -sh * H / 2], [0, 1, 0]], np.float32), (W, H), borderMode=cv2.BORDER_REPLICATE)
    return cv2.warpAffine(w1, cv2.getRotationMatrix2D((W / 2, H / 2), tilt, 1), (W, H), borderMode=cv2.BORDER_REPLICATE)
def frame(im):  # one camera frame with small hand movement and noise, so frames differ a little
    H, W = im.shape[:2]; M = cv2.getRotationMatrix2D((W / 2, H / 2), random.uniform(-1.5, 1.5), random.uniform(.97, 1.03)); M[:, 2] += [random.uniform(-2, 2), random.uniform(-1, 1)]
    f = cv2.warpAffine(im, M, (W, H), borderMode=cv2.BORDER_REPLICATE).astype(np.float32) + np.random.normal(0, 3, im.shape)
    return np.clip(f, 0, 255).astype(np.uint8)
FRAME_MS, MLKIT_MS, MAXF = 33, 400, 15
def v39(fr):
    last, streak = None, 0
    for i, f in enumerate(fr):
        t, c = read(f); ok = valid(t)
        if ok and c >= .8: return i + 1, t
        if ok and c >= .65: streak = streak + 1 if t == last else 1; last = t
        else: streak = 0
        if streak >= 3: return i + 1, t
    return None, None
def v310(fr):
    last, streak = None, 0
    for i, f in enumerate(fr):
        t, c = read(f)
        if not (valid(t) and c >= .95):
            g, _, _ = straighten(f); t2, c2 = read(g)
            if valid(t2) and (not valid(t) or c2 > c): t, c = t2, c2
        ok = valid(t)
        if ok and c >= .95: return i + 1, t
        if ok and c >= .8: streak = streak + 1 if t == last else 1; last = t
        else: streak = 0
        if streak >= 2: return i + 1, t
    return None, None
for kind in ('straight', 'side angle'):
    res = {'3.9': [], '3.10': []}
    for r in rows:
        im = cv2.imread(os.path.join(D, r['image_path'])); base = im if kind == 'straight' else warp(im)
        fr = [frame(base) for _ in range(MAXF)]
        for name, fn in (('3.9', v39), ('3.10', v310)): n, t = fn(fr); res[name].append((n, t == r['plate_text'] if n else None))
    for name, v in res.items():
        got = [n for n, ok in v if n]; wrong = sum(1 for n, ok in v if n and not ok)
        ms = [n * FRAME_MS for n in got]
        print(f'{kind:10s} {name:4s} | read by our reader within {MAXF} frames: {len(got) / len(v):.0%} | 1st frame {sum(1 for n in got if n == 1) / len(v):.0%} | avg {np.mean(ms):.0f} ms after plate in view | wrong {wrong} | rest left to ML Kit (~{MLKIT_MS} ms+)')
