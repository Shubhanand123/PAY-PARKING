# Character boxes (YOLO) -> plate number: group the characters into 1 or 2 rows, read each row left to right.
import os, sys, re, glob, csv, cv2, yaml, numpy as np
A = sys.argv[1]; out = os.path.join(A, 'ocrdata'); os.makedirs(os.path.join(out, 'extra'), exist_ok=True)
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
ok = lambda p: len(p) <= 10 and ((bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p)))
rows = []; seen = bad = 0
for name, crop in (('lyn3', False), ('lyn1', False), ('ipc', True)):
    names = yaml.safe_load(open(os.path.join(A, 'chars', name, 'data.yaml')))['names']
    for img in glob.glob(os.path.join(A, 'chars', name, '*', 'images', '*.jpg')):
        lab = img.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
        if not os.path.exists(lab): continue
        ch = []
        for line in open(lab):
            p = line.split()
            if len(p) < 5: continue
            c = str(names[int(p[0])]); x, y, w, h = map(float, p[1:5])
            if len(c) == 1 and c.isalnum(): ch.append((x, y, w, h, c.upper()))
        if len(ch) < 6: continue
        seen += 1
        hs = np.median([c[3] for c in ch]); ys = sorted(c[1] for c in ch)
        gaps = [(ys[i + 1] - ys[i], i) for i in range(len(ys) - 1)]
        g, i = max(gaps)
        if g > 0.6 * hs:  # two rows
            cut = (ys[i] + ys[i + 1]) / 2
            top = sorted([c for c in ch if c[1] < cut]); bot = sorted([c for c in ch if c[1] >= cut])
            text = ''.join(c[4] for c in top) + ''.join(c[4] for c in bot)
        else:
            text = ''.join(c[4] for c in sorted(ch))
        text = text.replace('O', '0') if False else text
        if not ok(text): bad += 1; continue
        im = cv2.imread(img); H, W = im.shape[:2]
        if crop:
            x1 = min(c[0] - c[2] / 2 for c in ch); x2 = max(c[0] + c[2] / 2 for c in ch); y1 = min(c[1] - c[3] / 2 for c in ch); y2 = max(c[1] + c[3] / 2 for c in ch)
            mx, my = (x2 - x1) * 0.08, (y2 - y1) * 0.25
            im = im[max(0, int((y1 - my) * H)):min(H, int((y2 + my) * H)), max(0, int((x1 - mx) * W)):min(W, int((x2 + mx) * W))]
            if im.size == 0: continue
        f = f'extra/{name}_{len(rows):05d}.png'; cv2.imwrite(os.path.join(out, f), im); rows.append((f, text))
with open(os.path.join(out, 'extra.csv'), 'w', newline='') as fh: w = csv.writer(fh); w.writerow(['image_path', 'plate_text']); w.writerows(rows)
print('images with characters', seen, '| valid Indian plates kept', len(rows), '| rejected (not a valid plate)', bad, '| different numbers', len({t for _, t in rows}))
