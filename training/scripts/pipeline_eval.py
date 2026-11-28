# Whole chain on the 163 test plates (full photos, Payals test split), straight and turned 20-50 deg to the side:
#   finder -> the app's grown box -> (straighten) -> reader -> the app's rules (valid plate, 95% taken at once, 80% with 2 frames).
# Ways of straightening compared: "now" = read, and if unsure PlateStraightener (tilt + lean); "corners" = 4-corner model
# warp, then read; "read, then corners" = read, and if unsure the corner warp (keep the surer reading).
# usage: pipeline_eval.py DET_DIR   env: FINDERS="name=path.onnx,..." READERS="name=path.onnx,..." CORNERS=corners.onnx
import os, sys, re, math, json, random, time, cv2, numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DET = sys.argv[1]; sys.argv = [sys.argv[0], DET]
import corner_train as C
from yolox_train import letterbox, pick
ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: len(p) <= 10 and ((bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p)))
MX, MY = 0.05, 0.10  # plate edges inside the reader picture (same as train.py and the app)
def sess(p, th=2):
    o = ort.SessionOptions(); o.intra_op_num_threads = th; return ort.InferenceSession(p, o, providers=['CPUExecutionProvider'])
def parse(env): return [tuple(x.split('=', 1)) for x in os.environ.get(env, '').split(',') if x]
FINDERS = [(n, sess(p, 4)) for n, p in parse('FINDERS')]; READERS = [(n, sess(p)) for n, p in parse('READERS')]
CORN = sess(os.environ['CORNERS']) if os.environ.get('CORNERS') else None

def find(s, im):
    size = s.get_inputs()[0].shape[2]; lb, _, (r, dx, dy) = letterbox(im, np.zeros((0, 4), np.float32), size)
    out = s.run(None, {s.get_inputs()[0].name: (lb[:, :, ::-1].transpose(2, 0, 1)[None] / 255).astype(np.float32)})[0]
    rows = out[:, [1, 2, 3, 4, 6]] if out.shape[1] == 7 else out
    h, w = im.shape[:2]; return pick(rows[rows[:, 4] >= 0.3], w, h, r, dx, dy)
def band_of(im, b):  # PlateScanActivity: box + 12% / 35%, small plates enlarged to 96 px high
    H, W = im.shape[:2]; x1, y1, x2, y2 = b; mx, my = (x2 - x1) * 0.12, (y2 - y1) * 0.35
    g = [max(0, round(x1 - mx)), max(0, round(y1 - my)), min(W, round(x2 + mx)), min(H, round(y2 + my))]
    if g[2] - g[0] <= 16 or g[3] - g[1] <= 8: return None
    band = im[g[1]:g[3], g[0]:g[2]]
    if band.shape[0] < 96: band = cv2.resize(band, (round(band.shape[1] * 96 / band.shape[0]), 96), interpolation=cv2.INTER_LINEAR)
    return band
def read(s, im):
    x = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (128, 64), interpolation=cv2.INTER_LINEAR)[None].astype(np.uint8)
    p = s.run(None, {'input': x})[0][0]; k = p.argmax(-1); t = ''.join(ALPHA[i] for i in k).replace('_', '')
    return t, (float(min(p.max(-1)[[ALPHA[i] != '_' for i in k]])) if t else 0.0)
def corners_warp(band):
    x = cv2.resize(band, (C.W, C.H), interpolation=cv2.INTER_AREA if band.shape[1] > C.W else cv2.INTER_LINEAR)
    q = CORN.run(None, {'band': (x[:, :, ::-1].transpose(2, 0, 1)[None] / 255).astype(np.float32)})[0].reshape(4, 2) * [band.shape[1], band.shape[0]]
    dst = np.float32([[MX * 128, MY * 64], [(1 - MX) * 128, MY * 64], [(1 - MX) * 128, (1 - MY) * 64], [MX * 128, (1 - MY) * 64]])
    return cv2.warpPerspective(band, cv2.getPerspectiveTransform(q.astype(np.float32), dst), (128, 64), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
def straighten(band):  # PlateStraightener.java (same as straight_test.py)
    H0, W0 = band.shape[:2]; w = 128; h = min(160, max(16, round(H0 * 128 / W0)))
    g = cv2.cvtColor(cv2.resize(band, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.int32)
    cut = int(g.mean() * 85 / 100); ys, xs = np.nonzero(g < cut); n = len(xs)
    if n < 40 or n > g.size * .6: return None
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
    if abs(bt) < 3 and abs(bsl) < .08: return None
    M3 = np.vstack([cv2.getRotationMatrix2D((W0 / 2, H0 / 2), bt, 1), [0, 0, 1]]); S = np.array([[1, bsl, -bsl * H0 / 2], [0, 1, 0], [0, 0, 1]])
    return cv2.warpAffine(band, (S @ M3)[:2], (W0, H0), borderMode=cv2.BORDER_REPLICATE)
def surer(a, b):  # the app keeps the second reading only if it is a valid plate and surer
    return b if b is not None and valid(b[0]) and (not valid(a[0]) or b[1] > a[1]) else a

j = json.load(open(os.path.join(DET, 'annotations', 'test.json'))); ims = {i['id']: i for i in j['images']}
plates = [(os.path.join(DET, 'test', ims[a['image_id']]['file_name']), np.array(a['bbox'], np.float32), a['text']) for a in j['annotations']
          if ims[a['image_id']]['source'] == 'payals' and valid(a.get('text', ''))]
if os.environ.get('UNSEEN_ONLY'):  # only plates whose number is not in this training list (same vehicle, other photo)
    import csv; seen = {r['plate_text'] for r in csv.DictReader(open(os.environ['UNSEEN_ONLY']))}; plates = [p for p in plates if p[2] not in seen]
random.seed(11); views = {'straight': [], 'turned 20-50 deg': [], 'moving (motion 10 px)': []}
for path, (x, y, w, h), text in plates:
    im = cv2.imread(path); q = np.float32([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); views['straight'].append((im, text))
    t, _ = C.turn(im, q, random.choice([-1, 1]) * random.uniform(20, 50), random.uniform(-10, 10), random.uniform(-6, 6), 1.6); views['turned 20-50 deg'].append((t, text))
    L = max(2, round(10 * w / 256))  # 10 px on a 256 px wide plate picture, scaled to this plate's width in the photo
    k = np.zeros((L, L), np.float32); k[L // 2] = 1; k = cv2.warpAffine(k, cv2.getRotationMatrix2D((L / 2 - .5, L / 2 - .5), random.uniform(-25, 25), 1), (L, L))
    views['moving (motion 10 px)'].append((cv2.filter2D(im, -1, k / max(k.sum(), 1e-6)), text))
print(len(plates), 'test plates (valid numbers) on full photos', flush=True)
results = {}
for fname, fs in FINDERS:
    for view, items in views.items():
        bands = [(band_of(im, b) if (b := find(fs, im)) is not None else None, t) for im, t in items]
        for rname, rs in READERS:
            modes = {'now: read, then tilt/lean if unsure': lambda bd: surer(r := read(rs, bd), None if r[1] >= .95 and valid(r[0]) else (lambda s: read(rs, s) if s is not None else None)(straighten(bd)))}
            if CORN is not None:
                modes['corners, then read'] = lambda bd: read(rs, corners_warp(bd))
                modes['read, then corners if unsure'] = lambda bd: surer(r := read(rs, bd), None if r[1] >= .95 and valid(r[0]) else read(rs, corners_warp(bd)))
            for mname, fn in modes.items():
                exact = n95 = w95 = n80 = w80 = 0; t0 = time.perf_counter()
                for bd, truth in bands:
                    if bd is None: continue
                    t, c = fn(bd); exact += t == truth
                    if valid(t) and c >= .95: n95 += 1; w95 += t != truth
                    if valid(t) and c >= .80: n80 += 1; w80 += t != truth
                ms = (time.perf_counter() - t0) / len(bands) * 1000; N = len(bands)
                key = f'{fname} | {view} | {rname} | {mname}'
                results[key] = dict(exact=exact / N, taken95=n95 / N, wrong95=w95, taken80=n80 / N, wrong80=w80, read_ms=ms)
                print(f'{key:100s} exact {exact / N:6.1%} | 95%+: taken {n95 / N:5.1%} wrong {w95:2d} | 80%+: taken {n80 / N:5.1%} wrong {w80:2d} | {ms:.1f} ms', flush=True)
json.dump(results, open(os.environ.get('OUT', 'pipeline_results.json'), 'w'), indent=1)
