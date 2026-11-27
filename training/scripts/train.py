# Fine-tunes the pre-trained fast-plate-ocr CCT-XS reader (MIT) on Indian plates: real crops (CC BY 4.0) + synthetic.
import os, json, sys, csv, random, time, math, numpy as np, cv2
os.environ['KERAS_BACKEND'] = 'tensorflow'; os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
import keras, tensorflow as tf
from fast_plate_ocr.train.model import layers  # noqa: F401 (custom layers for loading)
A = sys.argv[1]; D = os.path.join(A, 'ocrdata'); EPOCHS = int(sys.argv[2]) if len(sys.argv) > 2 else 40
ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'; SLOTS = 10; H, W = 64, 128
random.seed(1); np.random.seed(1); tf.random.set_seed(1)
# STRAIGHT=p: share of real plates shown as the app's 4-corner model would hand them over (turned in 3D, then warped flat
# from corners with CORNER_ERR error, as a fraction of plate width). Needs the 256 x 128 pictures, so real plates load at 2x.
STRAIGHT = float(os.environ.get('STRAIGHT', 0)); CORNER_ERR = float(os.environ.get('CORNER_ERR', 0.03)); HI = 2 if STRAIGHT else 1
def load(csvname, hi=1):
    rows = list(csv.DictReader(open(os.path.join(D, csvname))))
    X = np.zeros((len(rows), H * hi, W * hi, 3), np.uint8); Y = np.zeros((len(rows), SLOTS, len(ALPHA)), np.float32); T = []
    for i, r in enumerate(rows):
        im = cv2.imread(os.path.join(D, r['image_path']))
        X[i] = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (W * hi, H * hi), interpolation=cv2.INTER_AREA if hi == 1 and im.shape[1] > W else cv2.INTER_LINEAR)
        t = r['plate_text'].ljust(SLOTS, '_'); T.append(r['plate_text'])
        for j, ch in enumerate(t): Y[i, j, ALPHA.index(ch)] = 1
    return X, Y, T
Xr, Yr, _ = load('train.csv', HI); Xs, Ys, _ = load('synth.csv')
# more real Indian plates: character-labelled sets and self-labelled plates (if present)
for extra in ('extra.csv', 'self.csv', 'npds.csv', 'iurs.csv', 'hrlr.csv', 'hfgam.csv', 'kaggle.csv'):
    if os.path.exists(os.path.join(D, extra)):
        Xe, Ye, _ = load(extra, HI); Xr = np.concatenate([Xr, Xe]); Yr = np.concatenate([Yr, Ye]); print('added', extra, len(Xe), flush=True); Xv, Yv, Tv = load('val.csv'); Xt, Yt, Tt = load('test.csv')
print('real train', len(Xr), 'synthetic', len(Xs), 'val', len(Xv), 'test', len(Xt), flush=True)
def turn(im, q, yaw, pitch, roll, f_mult=1.6):
    """The plate (and the scene around it, as if flat) turned in 3D about the plate centre, seen by a camera at distance
    f = f_mult * picture size: near side larger, far side smaller and narrower (real side-angle view)."""
    h, w = im.shape[:2]; c = q.mean(0); f = f_mult * max(w, h)
    ry, rp, rr = map(np.radians, (yaw, pitch, roll))
    Ry = np.array([[np.cos(ry), 0, np.sin(ry)], [0, 1, 0], [-np.sin(ry), 0, np.cos(ry)]])
    Rx = np.array([[1, 0, 0], [0, np.cos(rp), -np.sin(rp)], [0, np.sin(rp), np.cos(rp)]])
    Rz = np.array([[np.cos(rr), -np.sin(rr), 0], [np.sin(rr), np.cos(rr), 0], [0, 0, 1]])
    R = Rz @ Rx @ Ry; K = np.array([[f, 0, c[0]], [0, f, c[1]], [0, 0, 1]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], [0, 0, f]]) @ np.array([[1, 0, -c[0]], [0, 1, -c[1]], [0, 0, 1]])
    out = cv2.warpPerspective(im, Hm, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    qq = cv2.perspectiveTransform(q[None].astype(np.float64), Hm)[0]
    return out, qq.astype(np.float32)
MX, MY = 0.05, 0.10  # plate edges inside the reader's 128 x 64 picture (also used by the app when it warps from corners)
def straightened(x2):
    # x2: a real plate at 256 x 128. Turned to a side angle, then warped flat from slightly wrong corners -> 128 x 64.
    h, w = x2.shape[:2]; q = np.float32([[MX * w, MY * h], [(1 - MX) * w, MY * h], [(1 - MX) * w, (1 - MY) * h], [MX * w, (1 - MY) * h]])
    x2 = cv2.copyMakeBorder(x2, h // 2, h // 2, w // 2, w // 2, cv2.BORDER_REFLECT); q = q + [w // 2, h // 2]  # room to turn
    if random.random() < 0.85: x2, q = turn(x2, q, random.choice([-1, 1]) * random.uniform(5, 55), random.uniform(-15, 15), random.uniform(-10, 10), random.uniform(1.0, 2.5))
    pw = np.linalg.norm(q[1] - q[0]); q = q + np.random.normal(0, CORNER_ERR * pw, q.shape)
    dst = np.float32([[MX * W, MY * H], [(1 - MX) * W, MY * H], [(1 - MX) * W, (1 - MY) * H], [MX * W, (1 - MY) * H]])
    return cv2.warpPerspective(x2, cv2.getPerspectiveTransform(q.astype(np.float32), dst), (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
def augment(x):
    if x.shape[0] != H: x = straightened(x) if random.random() < STRAIGHT else cv2.resize(x, (W, H), interpolation=cv2.INTER_AREA)
    x = x.astype(np.float32)
    if random.random() < 0.8: x = x * random.uniform(0.6, 1.35) + random.uniform(-35, 35)
    if random.random() < 0.3: x = cv2.GaussianBlur(x, (0, 0), random.uniform(0.3, 1.2))
    if random.random() < 0.35:  # hand shake: motion blur in a random direction, 3-9 px long
        k = random.choice([3, 5, 7, 9]); kern = np.zeros((k, k), np.float32); kern[k // 2, :] = 1
        M = cv2.getRotationMatrix2D((k / 2 - .5, k / 2 - .5), random.uniform(0, 180), 1); kern = cv2.warpAffine(kern, M, (k, k)); kern /= max(kern.sum(), 1e-6)
        x = cv2.filter2D(x, -1, kern)
    if random.random() < 0.5:
        M = cv2.getRotationMatrix2D((W / 2, H / 2), random.uniform(-6, 6), random.uniform(0.9, 1.08)); M[:, 2] += [random.uniform(-5, 5), random.uniform(-3, 3)]
        x = cv2.warpAffine(x, M, (W, H), borderMode=cv2.BORDER_REPLICATE)
    if random.random() < 0.15:  # side angle: plate seen from the left/right (perspective, up to ~45 deg) or slanted
        a = random.uniform(0.08, 0.32) * W; b = random.uniform(0.05, 0.25) * H; src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        if random.random() < 0.5: dst = np.float32([[0, 0], [W, b], [W, H - b], [0, H]]); dst[:, 0] = dst[:, 0] * (1 - a / W) + (a if False else 0)
        else: dst = np.float32([[0, b], [W, 0], [W, H], [0, H - b]]); dst[:, 0] = dst[:, 0] * (1 - a / W) + a
        sh = random.uniform(-0.08, 0.08) * W; dst[0, 0] += sh; dst[1, 0] += sh; dst[:, 0] = np.clip(dst[:, 0], 0, W)
        x = cv2.warpPerspective(x, cv2.getPerspectiveTransform(src, dst), (W, H), borderMode=cv2.BORDER_REPLICATE)
    if random.random() < 0.3: x = x + np.random.normal(0, random.uniform(2, 9), x.shape)
    return np.clip(x, 0, 255).astype(np.uint8)
class Batches(keras.utils.PyDataset):
    def __init__(self, bs=64, **kw):
        super().__init__(**kw); self.bs = bs; self.on_epoch_end()
    def on_epoch_end(self):
        # every epoch: all real plates x3 (they matter most) + 12,000 random synthetic ones
        idx = [('r', i) for i in range(len(Xr))] * 3 + [('s', i) for i in random.sample(range(len(Xs)), min(int(os.environ.get('SYNTH', 12000)), len(Xs)))]
        random.shuffle(idx); self.idx = idx[:int(os.environ['SMOKE'])] if os.environ.get('SMOKE') else idx
    def __len__(self): return len(self.idx) // self.bs
    def __getitem__(self, b):
        part = self.idx[b * self.bs:(b + 1) * self.bs]
        x = np.stack([augment(Xr[i] if k == 'r' else Xs[i]) for k, i in part]); y = np.stack([Yr[i] if k == 'r' else Ys[i] for k, i in part])
        return x, y
RESUME = os.environ.get('RESUME', os.path.join(A, 'resume_from.keras'))
if os.path.exists(RESUME):  # continue from the best model so far (training was interrupted)
    model = keras.models.load_model(RESUME, compile=False)
else:
    base = keras.models.load_model(os.path.join(A, 'pre/cct_xs_v2_global.keras'), compile=False)
    model = keras.Model(base.inputs, base.outputs[0], name='plate_reader_in')
def plate_acc(y_true, y_pred):
    return tf.reduce_mean(tf.cast(tf.reduce_all(tf.equal(tf.argmax(y_true, -1), tf.argmax(y_pred, -1)), axis=-1), tf.float32))
data = Batches(workers=4, use_multiprocessing=False)
steps = EPOCHS * len(data)
PEAK = float(os.environ.get('PEAK_LR', 8e-4))
sched = keras.optimizers.schedules.CosineDecay(PEAK / 8, steps, alpha=0.02, warmup_target=PEAK, warmup_steps=len(data))
model.compile(optimizer=keras.optimizers.AdamW(sched, weight_decay=0.01, clipnorm=1.0), loss=keras.losses.CategoricalCrossentropy(label_smoothing=0.02), metrics=[plate_acc])
def decode(p): return ''.join(ALPHA[k] for k in p.argmax(-1)).rstrip('_')
def score(X, T):
    P = model.predict(X, verbose=0, batch_size=256); return sum(decode(p) == t for p, t in zip(P, T)) / len(T)
# Every epoch the whole run (weights + optimizer + position) is saved, so a container restart loses at most one epoch.
LAST = os.path.join(A, os.environ.get('OUT', 'best_reader.keras') + '.last.keras'); LASTJ = LAST + '.json'; first = 0
if os.path.exists(LAST) and os.path.exists(LASTJ):
    st = json.load(open(LASTJ)); first = st['epoch']
    model = keras.models.load_model(LAST, custom_objects={'plate_acc': plate_acc})
    start_val, best = st['start_val'], st['best']
    print(f'continuing the interrupted run at epoch {first + 1}/{EPOCHS}, best so far {best:.3f}', flush=True)
else:
    start_val = score(Xv, Tv)
    print('before training: val', round(start_val, 3), 'test', round(score(Xt, Tt), 3), flush=True)
    best = start_val if os.path.exists(RESUME) else 0  # a resumed run only saves when it beats where it started
class Report(keras.callbacks.Callback):
    def on_epoch_end(self, ep, logs=None):
        global best
        v = score(Xv, Tv)
        if v > best: best = v; self.model.save(os.path.join(A, os.environ.get('OUT', 'best_reader.keras')))
        self.model.save(LAST); json.dump({'epoch': ep + 1, 'best': best, 'start_val': start_val}, open(LASTJ, 'w'))
        print(f'epoch {ep + 1}/{EPOCHS} loss {logs["loss"]:.3f} train-acc {logs["plate_acc"]:.3f} val-acc {v:.3f} best {best:.3f} {time.strftime("%H:%M:%S")}', flush=True)
model.fit(data, epochs=EPOCHS, initial_epoch=first, callbacks=[Report()], verbose=0)
for f in (LAST, LASTJ):
    if os.path.exists(f): os.remove(f)  # run finished
model = keras.models.load_model(os.path.join(A, os.environ.get('OUT', 'best_reader.keras')), compile=False, custom_objects={'plate_acc': plate_acc})
print('FINAL best model: val', round(score(Xv, Tv), 3), 'test (never seen)', round(score(Xt, Tt), 3), flush=True)
