# Export the YOLOX finder to ONNX and compare it with the app's current finder (YOLOv9-t 256) on the same test photos,
# using the app's own choice (score >= 0.3, nearest the middle). Speed: ONNX Runtime on this CPU, 1 and 4 threads.
# usage: finder_eval.py DET_DIR finder_best.pt OUT.onnx OLD_FINDER.onnx
import os, sys, time, json, numpy as np, cv2, torch, onnxruntime as ort
sys.argv, args = sys.argv[:2], sys.argv[1:]
import yolox_train as Y
DET, PT, ONNX, OLD = args
m = Y.Finder(); m.load_state_dict(torch.load(PT, map_location='cpu')); m.eval(); m.m.head.decode_in_inference = True
x = torch.zeros(1, 3, Y.SIZE, Y.SIZE)
torch.onnx.export(m, x, ONNX, input_names=['images'], output_names=['boxes'], opset_version=17, dynamo=False)
print('onnx', ONNX, os.path.getsize(ONNX) // 1024, 'KB')
def session(path, threads):
    o = ort.SessionOptions(); o.intra_op_num_threads = threads; o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, o, providers=['CPUExecutionProvider'])
def run_new(s, im):
    lb, _, (r, dx, dy) = Y.letterbox(im, np.zeros((0, 4), np.float32), Y.SIZE)
    rows = s.run(None, {'images': (lb[:, :, ::-1].transpose(2, 0, 1)[None] / 255).astype(np.float32)})[0]
    return rows[rows[:, 4] >= 0.3], (r, dx, dy)
def run_old(s, im):
    lb, _, (r, dx, dy) = Y.letterbox(im, np.zeros((0, 4), np.float32), 256)
    rows = s.run(None, {s.get_inputs()[0].name: (lb[:, :, ::-1].transpose(2, 0, 1)[None] / 255).astype(np.float32)})[0]
    return np.array([[q[1], q[2], q[3], q[4], q[6]] for q in rows if q[6] >= 0.3]).reshape(-1, 5), (r, dx, dy)
items = Y.load_set('test')
groups = {'163 test plates (payals test photos)': [i for i in items if i[2] == 'payals'], 'all test photos': items}
res = {}
for name, path, fn in (('YOLOv9-t 256 (now)', OLD, run_old), ('YOLOX-nano 224 (new)', ONNX, run_new)):
    s = session(path, 4); fn(s, cv2.imread(items[0][0]))
    for g, its in groups.items():
        h5 = h7 = 0
        for p, boxes, _ in its:
            im = cv2.imread(p); h, w = im.shape[:2]; rows, (r, dx, dy) = fn(s, im); b = Y.pick(rows, w, h, r, dx, dy)
            if b is None: continue
            best = max((Y.iou(b, (x0, y0, x0 + bw, y0 + bh)) for x0, y0, bw, bh in boxes), default=0); h5 += best >= .5; h7 += best >= .7
        res[(name, g)] = (h5 / len(its), h7 / len(its))
        print(f'{name:22s} {g:38s} found {h5}/{len(its)} = {h5 / len(its):.1%} | tight (IoU>=0.7) {h7 / len(its):.1%}', flush=True)
    ims = [cv2.imread(p) for p, _, _ in items[:150]]
    for th in (1, 4):
        s = session(path, th); fn(s, ims[0]); t = time.perf_counter()
        for im in ims: fn(s, im)
        ms = (time.perf_counter() - t) / len(ims) * 1000; res[(name, f'ms{th}')] = ms
        print(f'{name:22s} {th} thread(s): {ms:.1f} ms/photo (this CPU, incl. resize)', flush=True)
json.dump({f'{k[0]} | {k[1]}': v for k, v in res.items()}, open(ONNX + '.results.json', 'w'), indent=1)
