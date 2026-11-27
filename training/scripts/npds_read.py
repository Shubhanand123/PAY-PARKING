# Read every NPDS plate box (COCO) with our reader; report results; keep sure+valid+stable readings as new labels.
import os, sys, re, json, csv, cv2, time, numpy as np, onnxruntime as ort
A = sys.argv[1]; D = os.path.join(A, 'ocrdata'); os.makedirs(os.path.join(D, 'npds'), exist_ok=True)
ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: len(p) <= 10 and ((bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p)))
s = ort.InferenceSession(os.environ.get('READER', os.path.join(A, 'reader_v1.onnx')), providers=['CPUExecutionProvider'])
test_numbers = {r['plate_text'] for f in ('test.csv', 'val.csv') for r in csv.DictReader(open(os.path.join(D, f)))}
def read(c):
    x = cv2.resize(cv2.cvtColor(c, cv2.COLOR_BGR2RGB), (128, 64))[None].astype(np.uint8)
    p = s.run(None, {'input': x})[0][0]; k = p.argmax(-1); t = ''.join(ALPHA[i] for i in k).replace('_', '')
    return t, (min(p.max(-1)[[ALPHA[i] != '_' for i in k]]) if t else 0.0)
total = sure = sure_valid = kept = 0; rows = []; seen = set(); t0 = time.time()
for split in ('train', 'valid', 'test'):
    j = json.load(open(os.path.join(A, 'npds', split, '_annotations.coco.json'))); imgs = {i['id']: i['file_name'] for i in j['images']}
    by = {}
    for a in j['annotations']: by.setdefault(a['image_id'], []).append(a['bbox'])
    for iid, boxes in by.items():
        im = cv2.imread(os.path.join(A, 'npds', split, imgs[iid]))
        if im is None: continue
        H, W = im.shape[:2]
        for (x, y, w, h) in boxes:
            total += 1
            mx, my = w * 0.06, h * 0.12
            c = im[max(0, int(y - my)):min(H, int(y + h + my)), max(0, int(x - mx)):min(W, int(x + w + mx))]
            if c.size == 0 or c.shape[1] < 30 or c.shape[0] < 10: continue
            t, conf = read(c)
            if conf >= 0.95: sure += 1
            if conf >= 0.95 and valid(t):
                sure_valid += 1
                if t in test_numbers: continue
                if read(cv2.GaussianBlur(c, (0, 0), 0.8))[0] != t: continue
                hh, ww = c.shape[:2]
                if read(c[int(hh * .04):hh - int(hh * .04), int(ww * .03):ww - int(ww * .03)])[0] != t: continue
                if (t, c.shape) in seen: continue
                seen.add((t, c.shape)); f = f'npds/{len(rows):05d}.png'; cv2.imwrite(os.path.join(D, f), c); rows.append((f, t))
        if total % 2000 < len(boxes): print(f'{total} plates read, {time.time() - t0:.0f} s', flush=True)
with open(os.path.join(D, 'npds.csv'), 'w', newline='') as fh: w = csv.writer(fh); w.writerow(['image_path', 'plate_text']); w.writerows(rows)
print(f'RESULT: plates {total} | read with >=95% sureness {sure} ({sure / total:.0%}) | sure + valid Indian plate {sure_valid} ({sure_valid / total:.0%}) | new training labels (stable, no copies) {len(rows)} ({len({t for _, t in rows})} different numbers) | {time.time() - t0:.0f} s')
