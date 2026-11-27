import sys, glob, time, cv2, numpy as np, onnxruntime as ort
A = sys.argv[1]
imgs = sorted(glob.glob(A + '/india/test/images/*.jpg'))[:120]
def prep(im):
    h, w = im.shape[:2]; r = min(256 / w, 256 / h); nw, nh = int(round(w * r)), int(round(h * r))
    b = np.full((256, 256, 3), 114, np.uint8); dx, dy = (256 - nw) // 2, (256 - nh) // 2
    b[dy:dy + nh, dx:dx + nw] = cv2.resize(im, (nw, nh)); return (b[:, :, ::-1].transpose(2, 0, 1)[None] / 255.0).astype(np.float32)
res = {}
for name, path in (('fp32', glob.glob('/root/.cache/open-image-models/*256*/*.onnx')[0]), ('fp16', A + '/finder256_fp16.onnx')):
    o = ort.SessionOptions(); o.intra_op_num_threads = 4
    s = ort.InferenceSession(path, o, providers=['CPUExecutionProvider']); x = [prep(cv2.imread(p)) for p in imgs]
    s.run(None, {'images': x[0]}); t = time.perf_counter(); out = [s.run(None, {'images': xi})[0] for xi in x]
    res[name] = out; print(name, f'{(time.perf_counter() - t) / len(x) * 1000:.1f} ms/photo', 'boxes', sum(len([r for r in o_ if r[6] > .3]) for o_ in out))
agree = sum(1 for a, b in zip(res['fp32'], res['fp16']) if len([r for r in a if r[6] > .3]) == len([r for r in b if r[6] > .3]) and all(np.abs(np.array(sorted(r[1:5].tolist() for r in a if r[6] > .3)) - np.array(sorted(r[1:5].tolist() for r in b if r[6] > .3))).max(initial=0) < 3 for _ in [0]))
print('same boxes (within 3 px):', agree, '/', len(imgs))
