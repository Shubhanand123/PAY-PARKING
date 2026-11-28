# Night and glare: the val/test plates made dark + noisy, or with a bright glare band, read as they are, with CLAHE,
# and with the app's "stretch when dark" (PlateTextReader.brightenIfDark).  usage: night_eval.py OCRDATA reader.onnx
import sys, csv, numpy as np, cv2, onnxruntime as ort
D, R = sys.argv[1], sys.argv[2]; ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
s = ort.InferenceSession(R, providers=['CPUExecutionProvider'])
def read(im):
    p = s.run(None, {'input': cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (128, 64), interpolation=cv2.INTER_AREA)[None].astype(np.uint8)})[0][0]
    return ''.join(ALPHA[k] for k in p.argmax(-1)).replace('_', '')
cl = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 2))
def clahe(im):
    l, a, b = cv2.split(cv2.cvtColor(im, cv2.COLOR_BGR2LAB)); return cv2.cvtColor(cv2.merge([cl.apply(l), a, b]), cv2.COLOR_LAB2BGR)
def stretch(im, dark=80):  # same as the app: only when the picture is dark, 2nd..98th percentile of brightness -> 0..255
    y = im[:, :, 2] * 0.299 + im[:, :, 1] * 0.587 + im[:, :, 0] * 0.114
    if y.mean() >= dark: return im
    lo, hi = np.percentile(y, 2), np.percentile(y, 98)
    return im if hi - lo < 8 else np.clip((im.astype(np.float32) - lo) * 255 / (hi - lo), 0, 255).astype(np.uint8)
def dark(im, r): return np.clip(im.astype(np.float32) * r.uniform(0.18, 0.35) + r.normal(0, 4, im.shape), 0, 255).astype(np.uint8)
def glare(im, r):
    w = im.shape[1]; gx = r.uniform(0, w); g = np.clip(1 - np.abs(np.arange(w) - gx) / (w * .3), 0, 1) * r.uniform(90, 150)
    return np.clip(im.astype(np.float32) + g[None, :, None], 0, 255).astype(np.uint8)
for sp in ('val', 'test'):
    rows = list(csv.DictReader(open(f'{D}/{sp}.csv')))
    for name, fn in (('normal', lambda x, r: x), ('night (dark, noisy)', dark), ('glare (headlight/sun)', glare)):
        res = [0, 0, 0]; r = np.random.RandomState(4)
        for row in rows:
            im = fn(cv2.resize(cv2.imread(f"{D}/{row['image_path']}"), (256, 128)), r); t = row['plate_text']
            for k, v in enumerate((im, clahe(im), stretch(im))): res[k] += read(v) == t
        print(f'{sp:4s} {name:22s} as is {res[0] / len(rows):6.1%} | CLAHE {res[1] / len(rows):6.1%} | stretch when dark (app) {res[2] / len(rows):6.1%}')
