# IURS character boxes (COCO) -> plate crops + full text. One crop per original photo and plate.
import os, sys, json, csv, re, cv2, numpy as np
A = sys.argv[1]; SRC = os.path.join(A, 'iurs', 'data'); D = os.path.join(A, 'ocrdata'); os.makedirs(os.path.join(D, 'iurs'), exist_ok=True)
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: (bool(STD.match(p)) and p[:2] in STATES) or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p))
banned = {r['plate_text'] for f in ('test.csv', 'val.csv') for r in csv.DictReader(open(os.path.join(D, f)))}
rows, seen, stats = [], set(), {'plates': 0, 'valid': 0}
for split in ('train', 'valid', 'test'):
    d = json.load(open(os.path.join(SRC, split, '_annotations.coco.json'))); names = {c['id']: c['name'] for c in d['categories']}
    by = {}
    for a in d['annotations']:
        if len(names[a['category_id']]) == 1: by.setdefault(a['image_id'], []).append((names[a['category_id']], *a['bbox']))
    for im in d['images']:
        orig = im.get('extra', {}).get('name', im['file_name'])
        cs = by.get(im['id'], [])
        if not cs: continue
        # group characters into plates: linked when centres are within 2.5 character heights
        n = len(cs); par = list(range(n))
        def f(i):
            while par[i] != i: par[i] = par[par[i]]; i = par[i]
            return i
        for i in range(n):
            for j in range(i + 1, n):
                hi = max(cs[i][4], cs[j][4]); cx = lambda c: (c[1] + c[3] / 2, c[2] + c[4] / 2)
                (x1, y1), (x2, y2) = cx(cs[i]), cx(cs[j])
                if abs(x1 - x2) < 2.5 * hi and abs(y1 - y2) < 1.6 * hi: par[f(i)] = f(j)
        groups = {}
        for i in range(n): groups.setdefault(f(i), []).append(cs[i])
        img = None
        for g in groups.values():
            if len(g) < 6: continue
            stats['plates'] += 1
            h = float(np.median([c[4] for c in g])); ys = sorted(c[2] + c[4] / 2 for c in g)
            gaps = [ys[k + 1] - ys[k] for k in range(len(ys) - 1)]; cut = None
            if gaps and max(gaps) > 0.6 * h: k = int(np.argmax(gaps)); cut = (ys[k] + ys[k + 1]) / 2
            lines = [g] if cut is None else [[c for c in g if c[2] + c[4] / 2 < cut], [c for c in g if c[2] + c[4] / 2 >= cut]]
            text = ''.join(c[0] for line in lines for c in sorted(line, key=lambda c: c[1]))
            if not valid(text) or text in banned or (orig, text) in seen: continue
            seen.add((orig, text)); stats['valid'] += 1
            if img is None: img = cv2.imread(os.path.join(SRC, split, im['file_name']))
            x1 = min(c[1] for c in g); y1 = min(c[2] for c in g); x2 = max(c[1] + c[3] for c in g); y2 = max(c[2] + c[4] for c in g)
            mx, my = (x2 - x1) * .08, (y2 - y1) * .25
            crop = img[max(0, int(y1 - my)):int(y2 + my), max(0, int(x1 - mx)):int(x2 + mx)]
            if crop.size == 0: continue
            p = f'iurs/{len(rows):05d}.jpg'; cv2.imwrite(os.path.join(D, p), crop); rows.append((p, text))
with open(os.path.join(D, 'iurs.csv'), 'w') as fh:
    w = csv.writer(fh); w.writerow(['image_path', 'plate_text']); w.writerows(rows)
print(stats, 'crops', len(rows), 'different numbers', len({t for _, t in rows}))
