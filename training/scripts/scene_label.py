# Self-labelling from road photos with no plate boxes: our plate finder boxes plates, our reader reads them;
# keep only sure (>=0.95), valid Indian plates, never a val/test number, one crop per number. Resumable.
import os, sys, re, glob, csv, json, cv2, numpy as np, onnxruntime as ort
A, SRC, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
D = os.path.join(A, 'ocrdata'); OUT = os.path.join(D, NAME); os.makedirs(OUT, exist_ok=True)
ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: len(p) <= 10 and ((bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p)))
o = ort.SessionOptions(); o.intra_op_num_threads = 3
F = ort.InferenceSession('/home/user/PAY-PARKING/android/app/src/main/assets/models/plate_finder_256.onnx', o, providers=['CPUExecutionProvider'])
R = ort.InferenceSession(os.path.join(A, 'reader_v4.onnx'), o, providers=['CPUExecutionProvider'])
banned = {r['plate_text'] for f in ('test.csv', 'val.csv') for r in csv.DictReader(open(os.path.join(D, f)))}
def find(im):
    H, W = im.shape[:2]; r = min(256 / W, 256 / H); nw, nh = int(W * r), int(H * r); dx, dy = (256 - nw) // 2, (256 - nh) // 2
    b = np.full((256, 256, 3), 114, np.uint8); b[dy:dy + nh, dx:dx + nw] = cv2.resize(im, (nw, nh))
    x = cv2.cvtColor(b, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255
    out = F.run(None, {F.get_inputs()[0].name: x})[0]
    return [((q[1] - dx) / r, (q[2] - dy) / r, (q[3] - dx) / r, (q[4] - dy) / r) for q in out if len(q) >= 7 and q[6] >= 0.4]
def read(crop):
    x = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), (128, 64))[None].astype(np.uint8)
    p = R.run(None, {'input': x})[0][0]; k = p.argmax(-1); t = ''.join(ALPHA[i] for i in k).replace('_', '')
    return t, (float(min(p.max(-1)[[ALPHA[i] != '_' for i in k]])) if t else 0.0)
state_f = os.path.join(OUT, 'state.json'); st = json.load(open(state_f)) if os.path.exists(state_f) else {'done': 0, 'kept': {}, 'plates': 0}
imgs = sorted(glob.glob(os.path.join(SRC, '**', '*.jpg'), recursive=True))
for n, img in enumerate(imgs):
    if n < st['done']: continue
    im = cv2.imread(img)
    if im is not None:
        H, W = im.shape[:2]
        for x1, y1, x2, y2 in find(im):
            st['plates'] += 1; mx, my = int((x2 - x1) * .06), int((y2 - y1) * .12)
            crop = im[max(0, int(y1) - my):min(H, int(y2) + my), max(0, int(x1) - mx):min(W, int(x2) + mx)]
            if crop.size == 0 or crop.shape[1] < 40 or crop.shape[0] < 12: continue
            t, c = read(crop)
            if c >= .95 and valid(t) and t not in banned and t not in st['kept']:
                f = f'{NAME}/{len(st["kept"]):06d}.jpg'; cv2.imwrite(os.path.join(D, f), crop); st['kept'][t] = f
    st['done'] = n + 1
    if n % 200 == 0 or n == len(imgs) - 1:
        json.dump(st, open(state_f, 'w'))
        with open(os.path.join(D, NAME + '.csv'), 'w') as fh:
            w = csv.writer(fh); w.writerow(['image_path', 'plate_text']); [w.writerow([f, t]) for t, f in st['kept'].items()]
        print(f'{n + 1}/{len(imgs)} images, plates found {st["plates"]}, new labels {len(st["kept"])}', flush=True)
print('DONE', flush=True)
