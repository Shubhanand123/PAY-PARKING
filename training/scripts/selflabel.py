# Self-labelling: plate boxes without numbers -> our reader reads them; keep only sure, valid, stable readings.
import os, sys, re, glob, csv, cv2, numpy as np, onnxruntime as ort
A = sys.argv[1]; D = os.path.join(A, 'ocrdata'); os.makedirs(os.path.join(D, 'self'), exist_ok=True)
ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: len(p) <= 10 and ((bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p)))
s = ort.InferenceSession(os.path.join(A, 'plate_reader_in.onnx'), providers=['CPUExecutionProvider'])
test_numbers = {r['plate_text'] for r in csv.DictReader(open(os.path.join(D, 'test.csv')))} | {r['plate_text'] for r in csv.DictReader(open(os.path.join(D, 'val.csv')))}
def read(crop):
    x = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), (128, 64))[None].astype(np.uint8)
    p = s.run(None, {'input': x})[0][0]; k = p.argmax(-1); t = ''.join(ALPHA[i] for i in k).replace('_', '')
    return t, (min(p.max(-1)[[ALPHA[i] != '_' for i in k]]) if t else 0.0)
rows = []; boxes = kept = 0; seen_hash = set()
for sub in sorted(glob.glob(os.path.join(A, 'boxed', '*'))):
    for img in glob.glob(os.path.join(sub, '*', 'images', '*.jpg')):
        lab = img.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
        if not os.path.exists(lab): continue
        im = cv2.imread(img)
        if im is None: continue
        H, W = im.shape[:2]
        for j, line in enumerate(open(lab)):
            p = line.split()
            if len(p) < 5: continue
            x, y, w, h = map(float, p[1:5]); boxes += 1
            x1, y1, x2, y2 = int((x - w / 2) * W), int((y - h / 2) * H), int((x + w / 2) * W), int((y + h / 2) * H)
            mx, my = int((x2 - x1) * 0.06), int((y2 - y1) * 0.12)
            crop = im[max(0, y1 - my):min(H, y2 + my), max(0, x1 - mx):min(W, x2 + mx)]
            if crop.size == 0 or crop.shape[1] < 30 or crop.shape[0] < 10: continue
            t, c = read(crop)
            if c < 0.95 or not valid(t) or t in test_numbers: continue
            # stable under small changes: a little blur, and a slightly tighter crop
            t2, _ = read(cv2.GaussianBlur(crop, (0, 0), 0.8))
            hh, ww = crop.shape[:2]; t3, _ = read(crop[int(hh * .04):hh - int(hh * .04), int(ww * .03):ww - int(ww * .03)])
            if t2 != t or t3 != t: continue
            key = (t, crop.shape)  # same plate, same crop size: an augmented copy of the same photo
            if key in seen_hash: continue
            seen_hash.add(key)
            f = f'self/{os.path.basename(sub)}_{len(rows):05d}.png'; cv2.imwrite(os.path.join(D, f), crop); rows.append((f, t)); kept += 1
with open(os.path.join(D, 'self.csv'), 'w', newline='') as fh: wr = csv.writer(fh); wr.writerow(['image_path', 'plate_text']); wr.writerows(rows)
print('plate boxes', boxes, '| self-labelled (sure, valid, stable)', kept, '| different numbers', len({t for _, t in rows}))
