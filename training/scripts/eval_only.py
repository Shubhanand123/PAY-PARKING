import os, sys, csv, re, numpy as np, cv2
os.environ['KERAS_BACKEND'] = 'tensorflow'; os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
import keras, tensorflow as tf, tf2onnx, onnxruntime as ort
from fast_plate_ocr.train.model import layers  # noqa
A = sys.argv[1]; D = os.path.join(A, 'ocrdata'); ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
s = ort.InferenceSession(os.path.join(A, os.environ.get('ONNX', 'plate_reader_in.onnx')), providers=['CPUExecutionProvider'])
print('onnx size KB', os.path.getsize(os.path.join(A, os.environ.get('ONNX', 'plate_reader_in.onnx'))) // 1024, 'input', s.get_inputs()[0].type, s.get_inputs()[0].shape)
STATES = set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD = re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
valid = lambda p: bool(STD.match(p)) and p[:2] in STATES or bool(re.match(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p))
import time
for split in ('val', 'test'):
    rows = list(csv.DictReader(open(os.path.join(D, split + '.csv'))))
    X = np.stack([cv2.resize(cv2.cvtColor(cv2.imread(os.path.join(D, r['image_path'])), cv2.COLOR_BGR2RGB), (128, 64)) for r in rows]).astype(np.uint8)
    t0 = time.perf_counter(); P = np.concatenate([s.run(None, {'input': X[i:i + 1]})[0] for i in range(len(X))]); ms = (time.perf_counter() - t0) / len(X) * 1000
    texts = [''.join(ALPHA[k] for k in p.argmax(-1)).replace('_', '') for p in P]
    conf = [min(p.max(-1)[[ALPHA[k] != '_' for k in p.argmax(-1)]]) if t else 0 for p, t in zip(P, texts)]
    truth = [r['plate_text'] for r in rows]
    exact = np.mean([t == g for t, g in zip(texts, truth)])
    for th in (0.8, 0.9, 0.95):
        take = [i for i in range(len(rows)) if conf[i] >= th and valid(texts[i])]
        right = sum(texts[i] == truth[i] for i in take)
        print(f'{split}: all exact {exact:.1%} | sure (>= {th}) & valid: used for {len(take) / len(rows):.0%} of plates, right {right}/{len(take)} = {right / max(1, len(take)):.1%} | {ms:.1f} ms/plate')
