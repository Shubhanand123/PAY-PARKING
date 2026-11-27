# Builds plate-crop training data from two openly licensed (CC BY 4.0) Roboflow Universe datasets:
#  - payals-workspace "Indian Number Plate Detection" (full photos, box label = plate number)
#  - anpr-tsug0 "License Plate" (plate crops, folder name = plate number)
import os, re, glob, csv, cv2, yaml, sys
A = sys.argv[1]; out = os.path.join(A, 'ocrdata')
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
BH = re.compile(r'^\d{2}BH\d{4}[A-Z]{1,2}$')
ok = lambda p: len(p) <= 10 and (bool(BH.match(p)) or (bool(STD.match(p)) and p[:2] in STATES))
rows = {'train': [], 'val': [], 'test': []}
split_of = {'train': 'train', 'valid': 'val', 'test': 'test'}
names = yaml.safe_load(open(os.path.join(A, 'india/data.yaml')))['names']
for sp in ('train', 'valid', 'test'):
    d = os.path.join(out, split_of[sp]); os.makedirs(d, exist_ok=True)
    for img in glob.glob(os.path.join(A, 'india', sp, 'images', '*.jpg')):
        im = cv2.imread(img); h, w = im.shape[:2]
        lab = img.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
        for i, line in enumerate(open(lab)):
            c, x, y, bw, bh = map(float, line.split()[:5]); text = str(names[int(c)]).upper()
            if not ok(text): continue
            x1, y1 = max(0, int((x - bw / 2) * w) - 2), max(0, int((y - bh / 2) * h) - 2)
            x2, y2 = min(w, int((x + bw / 2) * w) + 2), min(h, int((y + bh / 2) * h) + 2)
            if x2 - x1 < 12 or y2 - y1 < 6: continue
            name = f'in_{os.path.basename(img)[:40]}_{i}.png'
            cv2.imwrite(os.path.join(d, name), im[y1:y2, x1:x2]); rows[split_of[sp]].append((split_of[sp] + '/' + name, text))
    for f in glob.glob(os.path.join(A, 'crops', sp, '*', '*.jpg')):
        text = os.path.basename(os.path.dirname(f)).upper()
        if not ok(text): continue
        name = 'an_' + os.path.basename(f)[:60] + '.png'
        cv2.imwrite(os.path.join(d, name), cv2.imread(f)); rows[split_of[sp]].append((split_of[sp] + '/' + name, text))
for sp, r in rows.items():
    with open(os.path.join(out, sp + '.csv'), 'w', newline='') as fh:
        wr = csv.writer(fh); wr.writerow(['image_path', 'plate_text']); wr.writerows(r)
    print(sp, len(r), 'plates,', len({t for _, t in r}), 'different numbers')
