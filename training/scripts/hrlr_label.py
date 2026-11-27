# HR-LR (Hugging Face, NO licence — kept separate in hrlr.csv) -> label with reader v4: try as-is, straightened, mirrored, upside-down.
import sys, glob, csv, os, cv2
sys.argv = [sys.argv[0], sys.argv[1]]
src = open('scripts/straight_test.py').read(); exec(src[:src.index('rows = list(csv.DictReader')])
banned = {r['plate_text'] for f in ('test.csv', 'val.csv') for r in csv.DictReader(open(os.path.join(D, f)))}
os.makedirs(os.path.join(D, 'hrlr'), exist_ok=True); rows = []; tried = 0
for f in sorted(glob.glob(os.path.join(A, 'hrlr/hr/HR/*.png'))):
    im = cv2.imread(f); tried += 1; best = ('', 0, None)
    for v in (im, cv2.flip(im, 1), cv2.flip(im, 0), cv2.rotate(im, cv2.ROTATE_180)):
        for w in (v, straighten(v)[0]):
            t, c = read(w)
            if valid(t) and c > best[1]: best = (t, c, w)
    t, c, w = best
    if c >= .95 and t not in banned:
        p = f'hrlr/{len(rows):05d}.jpg'; cv2.imwrite(os.path.join(D, p), w); rows.append((p, t))
    if tried % 1000 == 0: print(tried, 'checked,', len(rows), 'labelled', flush=True)
with open(os.path.join(D, 'hrlr.csv'), 'w') as h:
    wr = csv.writer(h); wr.writerow(['image_path', 'plate_text']); wr.writerows(rows)
old = set()
for f in ('train', 'extra', 'self', 'npds', 'iurs'): old |= {r['plate_text'] for r in csv.DictReader(open(os.path.join(D, f + '.csv')))}
new = {t for _, t in rows}
print('DONE checked', tried, 'labelled', len(rows), 'different numbers', len(new), 'not seen before', len(new - old))
