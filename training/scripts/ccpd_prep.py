# CCPD (Chinese City Parking Dataset, ECCV 2018, MIT licence, github.com/detectRecog/CCPD) -> extra TRAINING photos for the
# plate finder and the 4-corner model: exact plate corners for real plates, many tilted, rotated, blurred (moving), at night.
# Appended to DET/annotations/train.json as source 'ccpd' (val/test stay the Indian sets). Pictures stored at 320 px.
# CCPD file name: area-tiltH_tiltV-x1&y1_x2&y2-RBx&RBy_LBx&LBy_LTx&LTy_RTx&RTy-plate-brightness-blurriness.jpg
# usage: ccpd_prep.py CCPD_ROOT DET_DIR [SCALE]   (SCALE 1.0 = about 40,000 photos)
import os, sys, json, glob, random, cv2
from multiprocessing import Pool
ROOT, DET = sys.argv[1], sys.argv[2]; SCALE = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0; SIDE = 320
CAPS = {'ccpd_base': 12000, 'ccpd_blur': 6000, 'ccpd_tilt': 6000, 'ccpd_rotate': 4000, 'ccpd_challenge': 4000,
        'ccpd_db': 3000, 'ccpd_fn': 3000, 'ccpd_weather': 2000, 'ccpd_green': 2000}
def parse(path):
    f = os.path.basename(path).rsplit('.', 1)[0].split('-')
    if len(f) < 7: return None
    try:
        pts = [tuple(map(float, p.split('&'))) for p in f[3].split('_')]  # RB, LB, LT, RT
        if len(pts) != 4: return None
        rb, lb, lt, rt = pts; return [lt, rt, rb, lb]                        # -> TL, TR, BR, BL
    except ValueError: return None
def work(job):
    k, path, quad = job
    im = cv2.imread(path)
    if im is None: return None
    h, w = im.shape[:2]; r = SIDE / max(h, w); im = cv2.resize(im, (round(w * r), round(h * r)), interpolation=cv2.INTER_AREA)
    name = f'ccpd_{k:06d}.jpg'; cv2.imwrite(os.path.join(DET, 'train', name), im, [cv2.IMWRITE_JPEG_QUALITY, 88])
    q = [[x * r, y * r] for x, y in quad]; xs = [p[0] for p in q]; ys = [p[1] for p in q]
    return name, im.shape[1], im.shape[0], q, [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]
if __name__ == '__main__':
    random.seed(3); jobs = []
    for sub, cap in CAPS.items():
        files = sorted(glob.glob(os.path.join(ROOT, '**', sub, '*.jpg'), recursive=True))
        files = [(p, q) for p in files if (q := parse(p))]
        random.shuffle(files); files = files[:int(cap * SCALE)]
        print(f'{sub}: {len(files)} photos', flush=True)
        jobs += [(len(jobs) + i, p, q) for i, (p, q) in enumerate(files)]
    if not jobs: print('no CCPD photos found under', ROOT); sys.exit(1)
    os.makedirs(os.path.join(DET, 'train'), exist_ok=True)
    with Pool() as pool: res = [r for r in pool.map(work, jobs, chunksize=64) if r]
    ann = json.load(open(os.path.join(DET, 'annotations', 'train.json')))
    iid = max(i['id'] for i in ann['images']); aid = max(a['id'] for a in ann['annotations'])
    for name, w, h, q, b in res:
        iid += 1; aid += 1
        ann['images'].append({'id': iid, 'file_name': name, 'width': w, 'height': h, 'source': 'ccpd'})
        ann['annotations'].append({'id': aid, 'image_id': iid, 'category_id': 1, 'iscrowd': 0, 'bbox': b, 'area': b[2] * b[3], 'quad': q})
    json.dump(ann, open(os.path.join(DET, 'annotations', 'train.json'), 'w'))
    print('CCPD photos added to train:', len(res), flush=True)
