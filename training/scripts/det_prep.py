# Full photos with plate boxes -> one small COCO set for the plate finder (YOLOX) and the 4-corner model.
# Sources (all CC BY 4.0): Mendeley NPDS (sxrnr7hwtk), Roboflow "Indian Number Plate Detection" (payals) and
# "Indian-License-Plate-Merged" (abduls), plus the two Roboflow 4-corner sets (mydataset-zrfok, raymond-bepag).
# Roboflow made 3 augmented copies of most photos: keep one per original photo. Photos in any test split never
# appear in train/val (matched by name and by a small picture hash). Pictures are stored at 320 px (longest side).
# usage: det_prep.py RAW_DIR OUT_DIR      (RAW_DIR has npds/ payals/ merged/ kp1/ kp2/ as unzipped COCO exports)
import os, sys, re, json, cv2, numpy as np
RAW, OUT = sys.argv[1], sys.argv[2]; SIDE = 320
SETS = ['payals', 'npds', 'merged', 'kp1', 'kp2']
SPLIT = {'train': 'train', 'valid': 'val', 'test': 'test'}
base = lambda f: re.sub(r'_(jpg|jpeg|png|JPG|JPEG|PNG)\.rf\..*', '', f)
def dhash(im):
    g = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (9, 8), interpolation=cv2.INTER_AREA)
    return int(''.join('1' if v else '0' for v in (g[:, 1:] > g[:, :-1]).flatten()), 2)
items = []  # (set, split, path, boxes[(x,y,w,h)], quads or None)
for s in SETS:
    for sp in ('train', 'valid', 'test'):
        p = os.path.join(RAW, s, sp, '_annotations.coco.json')
        if not os.path.exists(p): continue
        j = json.load(open(p)); by = {}; cat = {c['id']: c['name'] for c in j['categories']}
        for a in j['annotations']:
            if a['bbox'][2] < 4 or a['bbox'][3] < 3: continue
            by.setdefault(a['image_id'], []).append(a)
        seen = set()
        for im in j['images']:
            b = base(im['file_name'])
            if b in seen or im['id'] not in by: continue
            seen.add(b); anns = by[im['id']]
            quads = [a['keypoints'] for a in anns] if all(len(a.get('keypoints', [])) == 12 for a in anns) else None
            texts = [cat[a['category_id']].upper() if s == 'payals' else None for a in anns]  # payals: box label = plate number
            items.append((s, SPLIT[sp], os.path.join(RAW, s, sp, im['file_name']), [a['bbox'] for a in anns], quads, b, texts))
print('photos (one per original):', len(items))
hashes = {}
for k, it in enumerate(items):
    im = cv2.imread(it[2]); hashes[k] = dhash(im) if im is not None else None
test_h = {hashes[k] for k, it in enumerate(items) if it[1] == 'test'}
test_b = {it[5] for it in items if it[1] == 'test'}
val_h = {hashes[k] for k, it in enumerate(items) if it[1] == 'val'}
out = {sp: {'images': [], 'annotations': [], 'categories': [{'id': 1, 'name': 'plate'}]} for sp in ('train', 'val', 'test')}
dropped = 0; used_h = set()
for k, (s, sp, path, boxes, quads, b, texts) in enumerate(items):
    h = hashes[k]
    if h is None: continue
    if sp != 'test' and (h in test_h or b in test_b): dropped += 1; continue
    if sp == 'train' and h in val_h: dropped += 1; continue
    if (sp, h) in used_h: dropped += 1; continue  # same photo in two sets
    used_h.add((sp, h))
    im = cv2.imread(path); H, W = im.shape[:2]; r = SIDE / max(H, W)
    im = cv2.resize(im, (round(W * r), round(H * r)), interpolation=cv2.INTER_AREA)
    d = os.path.join(OUT, sp); os.makedirs(d, exist_ok=True)
    name = f'{s}_{len(out[sp]["images"]):05d}.jpg'; cv2.imwrite(os.path.join(d, name), im, [cv2.IMWRITE_JPEG_QUALITY, 88])
    iid = len(out[sp]['images']) + 1
    out[sp]['images'].append({'id': iid, 'file_name': name, 'width': im.shape[1], 'height': im.shape[0], 'source': s})
    for n, (x, y, w, hh) in enumerate(boxes):
        a = {'id': len(out[sp]['annotations']) + 1, 'image_id': iid, 'category_id': 1, 'iscrowd': 0,
             'bbox': [x * r, y * r, w * r, hh * r], 'area': w * hh * r * r}
        if texts[n]: a['text'] = texts[n]
        if quads: a['quad'] = [[quads[n][3 * c] * r, quads[n][3 * c + 1] * r] for c in range(4)]  # TL TR BR BL
        out[sp]['annotations'].append(a)
os.makedirs(os.path.join(OUT, 'annotations'), exist_ok=True)
for sp, j in out.items():
    json.dump(j, open(os.path.join(OUT, 'annotations', sp + '.json'), 'w'))
    by = {}
    for im in j['images']: by[im['source']] = by.get(im['source'], 0) + 1
    print(sp, len(j['images']), 'photos', len(j['annotations']), 'plates', by)
print('dropped as copies of test/val or of each other:', dropped)
