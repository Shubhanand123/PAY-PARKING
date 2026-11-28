# How well a reader copes with moving vehicles: the val/test plates with motion blur (vehicle moving, hand shake) and
# defocus, at fixed strengths, same random choices for every model.  usage: blur_eval.py OCRDATA reader1.onnx [reader2.onnx ...]
import os, sys, csv, random, re, numpy as np, cv2, onnxruntime as ort
D = sys.argv[1]; ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: (bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p))
def motion(im, length, angle):
    if length < 2: return im
    k = np.zeros((length, length), np.float32); k[length // 2] = 1
    k = cv2.warpAffine(k, cv2.getRotationMatrix2D((length / 2 - .5, length / 2 - .5), angle, 1), (length, length)); k /= max(k.sum(), 1e-6)
    return cv2.filter2D(im, -1, k)
# strengths in pixels of the 256 x 128 plate picture (the reader sees half of that)
LEVELS = [('sharp', 0, 0), ('moving slowly (motion 6 px)', 6, 0), ('moving (motion 10 px)', 10, 0), ('moving fast (motion 16 px)', 16, 0),
          ('out of focus (blur 2 px)', 0, 2.0), ('moving + out of focus', 10, 1.5)]
def views(split):
    rows = list(csv.DictReader(open(os.path.join(D, split + '.csv')))); out = {}
    for name, L, sig in LEVELS:
        rnd = random.Random(7); X = []
        for r in rows:
            im = cv2.resize(cv2.imread(os.path.join(D, r['image_path'])), (256, 128), interpolation=cv2.INTER_LINEAR)
            ang = rnd.uniform(-25, 25) if rnd.random() < 0.7 else rnd.uniform(65, 115)  # mostly sideways, sometimes towards the camera
            if L: im = motion(im, L, ang)
            if sig: im = cv2.GaussianBlur(im, (0, 0), sig)
            X.append(cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (128, 64), interpolation=cv2.INTER_AREA))
        out[name] = np.stack(X).astype(np.uint8)
    return out, [r['plate_text'] for r in rows]
data = {sp: views(sp) for sp in ('val', 'test')}
for path in sys.argv[2:]:
    s = ort.InferenceSession(path, providers=['CPUExecutionProvider']); print(os.path.basename(path))
    for sp, (vs, truth) in data.items():
        for name, X in vs.items():
            P = np.concatenate([s.run(None, {'input': X[i:i + 64]})[0] for i in range(0, len(X), 64)])
            texts = [''.join(ALPHA[k] for k in p.argmax(-1)).replace('_', '') for p in P]
            conf = [float(min(p.max(-1)[[ALPHA[k] != '_' for k in p.argmax(-1)]])) if t else 0 for p, t in zip(P, texts)]
            ex = np.mean([t == g for t, g in zip(texts, truth)])
            take = [i for i in range(len(truth)) if conf[i] >= .95 and valid(texts[i])]; wrong = sum(texts[i] != truth[i] for i in take)
            print(f'  {sp:4s} {name:28s} exact {ex:6.1%} | 95%+ sure: used {len(take) / len(truth):5.1%}, wrong {wrong}', flush=True)
