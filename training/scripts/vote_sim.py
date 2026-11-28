# Moving vehicle, several camera frames: one reading vs. letter-by-letter voting across frames (what app 3.13 does).
# Each test plate is shown 3 times with different motion blur (6-16 px at 256 px, different directions) and small shifts.
# Voting: each of the reader's 10 letter slots adds up its probabilities over the frames; frames much blurrier than the
# sharpest one (Laplacian variance < 50% of it) are left out.  usage: vote_sim.py OCRDATA reader.onnx
import os, sys, csv, random, re, numpy as np, cv2, onnxruntime as ort
D, R = sys.argv[1], sys.argv[2]; ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: (bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p))
s = ort.InferenceSession(R, providers=['CPUExecutionProvider']); VOTE = float(os.environ.get('VOTE', 0.80))
def frame(im, rnd):
    L = rnd.randint(6, 16); k = np.zeros((L, L), np.float32); k[L // 2] = 1
    k = cv2.warpAffine(k, cv2.getRotationMatrix2D((L / 2 - .5, L / 2 - .5), rnd.uniform(-25, 25), 1), (L, L))
    f = cv2.filter2D(im, -1, k / max(k.sum(), 1e-6))
    M = np.float32([[1, 0, rnd.uniform(-4, 4)], [0, 1, rnd.uniform(-3, 3)]]); return cv2.warpAffine(f, M, (256, 128), borderMode=cv2.BORDER_REPLICATE)
def sharp(im): return cv2.Laplacian(cv2.cvtColor(cv2.resize(im, (128, 64), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY), cv2.CV_32F).var()
def probs(im): return s.run(None, {'input': cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (128, 64), interpolation=cv2.INTER_AREA)[None].astype(np.uint8)})[0][0]
def decode(p):
    k = p.argmax(-1); t = ''.join(ALPHA[i] for i in k).replace('_', ''); return t, (float(min(p.max(-1)[[ALPHA[i] != '_' for i in k]])) if t else 0.0)
for split in ('test', 'val'):
    rows = list(csv.DictReader(open(os.path.join(D, split + '.csv')))); rnd = random.Random(3); st = {}
    for r in rows:
        im = cv2.resize(cv2.imread(os.path.join(D, r['image_path'])), (256, 128)); fr = [frame(im, rnd) for _ in range(3)]
        P = [probs(f) for f in fr]; sh = [sharp(f) for f in fr]; truth = r['plate_text']
        single = decode(P[0])
        keep = [p for p, v in zip(P, sh) if v >= 0.5 * max(sh)]; voted = decode(np.mean(keep, 0))
        best = decode(P[int(np.argmax(sh))])
        # app 3.13 rule: the sharpest frame's reading if 95%+ sure, else the letter vote if 80%+ sure (from 2+ frames)
        comb = best if (valid(best[0]) and best[1] >= .95) else (voted if (len(keep) >= 2 and valid(voted[0]) and voted[1] >= VOTE) else ('', 0.0))
        for name, (t, c) in (('1 frame', single), ('sharpest of 3 frames', best), ('letter vote over 3 frames', voted), ('app 3.13 rule', comb)):
            a = st.setdefault(name, [0, 0, 0]); a[0] += t == truth
            if valid(t) and c >= (VOTE if name == 'app 3.13 rule' else .95): a[1] += 1; a[2] += t != truth
    print(f'{split} ({len(rows)} plates, vehicle moving: blur 6-16 px per frame)')
    for name, (ok, taken, wrong) in st.items(): print(f'  {name:26s} exact {ok / len(rows):6.1%} | filled in: {taken / len(rows):5.1%}, wrong {wrong}')
