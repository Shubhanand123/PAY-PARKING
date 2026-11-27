# Turn each labelled crop the right way round (Roboflow added mirrored/rotated copies) and drop unreadable ones.
import os, sys, csv, cv2, numpy as np, onnxruntime as ort
A, NAME = sys.argv[1], sys.argv[2]; D = os.path.join(A, 'ocrdata'); ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
R = ort.InferenceSession(os.path.join(A, 'reader_v4.onnx'), providers=['CPUExecutionProvider'])
def ll(img, text):
    x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (128, 64))[None].astype(np.uint8)
    p = R.run(None, {'input': x})[0][0]; t = text.ljust(p.shape[0], '_')
    return float(np.mean(np.log([p[i, ALPHA.index(c)] + 1e-9 for i, c in enumerate(t)])))
rows = list(csv.DictReader(open(os.path.join(D, NAME + '.csv')))); keep = []; flips = drop = 0
for r in rows:
    if len(r["plate_text"]) > 10: drop += 1; continue
    im = cv2.imread(os.path.join(D, r['image_path']))
    vs = [im, cv2.flip(im, 1), cv2.flip(im, 0), cv2.rotate(im, cv2.ROTATE_180)]
    sc = [ll(v, r['plate_text']) for v in vs]; k = int(np.argmax(sc))
    if sc[k] < np.log(0.3): drop += 1; continue   # even the right way round, too unclear to teach from
    if k: cv2.imwrite(os.path.join(D, r['image_path']), vs[k]); flips += 1
    keep.append(r)
with open(os.path.join(D, NAME + '.csv'), 'w') as fh:
    w = csv.DictWriter(fh, ['image_path', 'plate_text']); w.writeheader(); w.writerows(keep)
print('kept', len(keep), 'turned', flips, 'dropped', drop)
