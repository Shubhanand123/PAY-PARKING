# Same algorithm as PlateStraightener.java, tested on the 163 unseen test plates warped to side angles.
import os, sys, csv, random, math, cv2, numpy as np, onnxruntime as ort
import re
STATES=set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD=re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid=lambda p: bool(STD.match(p)) and p[:2] in STATES
A = sys.argv[1]; D = os.path.join(A, 'ocrdata'); ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
R = ort.InferenceSession(os.path.join(A, 'reader_v4.onnx'), providers=['CPUExecutionProvider'])
def read(im):
    x = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (128, 64))[None].astype(np.uint8)
    p = R.run(None, {'input': x})[0][0]; k = p.argmax(-1); t = ''.join(ALPHA[i] for i in k).replace('_', '')
    return t, (float(min(p.max(-1)[[ALPHA[i] != '_' for i in k]])) if t else 0.0)
def straighten(band):
    H0, W0 = band.shape[:2]; w = 128; h = min(160, max(16, round(H0 * 128 / W0)))
    g = cv2.cvtColor(cv2.resize(band, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.int32)
    cut = int(g.mean() * 85 / 100); ys, xs = np.nonzero(g < cut); n = len(xs)
    if n < 40 or n > g.size * .6: return band, 0, 0
    xs = xs - w / 2; ys = ys - h / 2
    def sq(v, bins):
        b = np.round(v).astype(int) + bins // 2; b = b[(b >= 0) & (b < bins)]; return float((np.bincount(b, minlength=bins) ** 2).sum())
    bt, bs = 0, -1
    for d in range(-20, 21, 2):
        a = math.radians(d); sc = sq(-xs * math.sin(a) + ys * math.cos(a), h * 2)
        if sc > bs * 1.02 or (d == 0 and sc >= bs * .98): bs, bt = sc, d
    a = math.radians(bt); ux = xs * math.cos(a) + ys * math.sin(a); uy = -xs * math.sin(a) + ys * math.cos(a)
    bsl, bs = 0, -1
    for t in range(-10, 11):
        sh = t * .05; sc = sq(ux + sh * uy, w * 2)
        if sc > bs * 1.02 or (t == 0 and sc >= bs * .98): bs, bsl = sc, sh
    if abs(bt) < 3 and abs(bsl) < .08: return band, bt, bsl
    c = (W0 / 2, H0 / 2); M = cv2.getRotationMatrix2D(c, bt, 1)   # cv2: positive = counter-clockwise, i.e. undoes a +bt tilt
    M3 = np.vstack([M, [0, 0, 1]]); S = np.array([[1, bsl, -bsl * H0 / 2], [0, 1, 0], [0, 0, 1]])
    out = cv2.warpAffine(band, (S @ M3)[:2], (W0, H0), borderMode=cv2.BORDER_REPLICATE); return out, bt, bsl
rows = list(csv.DictReader(open(os.path.join(D, 'test.csv')))); random.seed(7)
stats = {k: [0, 0, 0] for k in ('straight', 'side angle', 'side angle + straightened')}
for r in rows:
    im = cv2.imread(os.path.join(D, r['image_path'])); H, W = im.shape[:2]; truth = r['plate_text']
    # side angle: shear + small tilt + perspective squeeze of one side
    sh = random.choice([-1, 1]) * random.uniform(.15, .35); tilt = random.uniform(-10, 10); sq_ = random.uniform(.1, .25)
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]]); dst = src.copy(); dst[1, 1] += sq_ * H / 2; dst[2, 1] -= sq_ * H / 2
    w1 = cv2.warpPerspective(im, cv2.getPerspectiveTransform(src, dst), (W, H), borderMode=cv2.BORDER_REPLICATE)
    M = np.array([[1, sh, -sh * H / 2], [0, 1, 0]], np.float32); w1 = cv2.warpAffine(w1, M, (W, H), borderMode=cv2.BORDER_REPLICATE)
    w1 = cv2.warpAffine(w1, cv2.getRotationMatrix2D((W / 2, H / 2), tilt, 1), (W, H), borderMode=cv2.BORDER_REPLICATE)
    fixed, _, _ = straighten(w1)
    def fb(a, b):
        t, c = read(a)
        if c >= .8: return t, c
        t2, c2 = read(b); return (t2, c2) if c2 > c else (t, c)
    for k, (t, c) in (('side angle, fallback', fb(w1, fixed)), ('straight, fallback', fb(im, straighten(im)[0]))):
        s = stats.setdefault(k, [0, 0, 0]); s[0] += t == truth; v = c >= .8 and valid(t); s[1] += v; s[2] += v and t == truth
    for k, img in (('straight', im), ('side angle', w1), ('side angle + straightened', fixed)):
        t, c = read(img); s = stats[k]; s[0] += t == truth; v = c >= .8 and valid(t); s[1] += v; s[2] += v and t == truth
    # straight plates must not be harmed
    f2, _, _ = straighten(im); t, c = read(f2); stats.setdefault('straight + straightened', [0, 0, 0]); s = stats['straight + straightened']; s[0] += t == truth; v = c >= .8 and valid(t); s[1] += v; s[2] += v and t == truth
for k, (ok, sure, sure_ok) in stats.items(): print(f'{k:28s} exact {ok / len(rows):.1%} | sure (80%+) on {sure / len(rows):.0%} | wrong when sure {sure - sure_ok}')
