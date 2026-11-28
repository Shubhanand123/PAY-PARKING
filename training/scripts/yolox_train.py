# Plate finder: YOLOX-nano (Apache-2.0, Megvii) at 224 x 224, fine-tuned from the COCO weights on Indian plate photos.
# Same input as the app's PlateFinder: RGB 0..1, letterboxed (centred, grey 114). The ImageNet normalisation of the
# legacy YOLOX weights is done inside the model, so the app feeds exactly what it feeds the current finder.
# Saves every epoch (resumes after a restart); keeps the model with the best "plate found" score on val.
# usage: yolox_train.py DET_DIR OUT_DIR EPOCHS     env: YOLOX_SRC (repo path), WEIGHTS (yolox_nano.pth), BS, WORKERS
import os, sys, json, math, random, time, cv2, numpy as np, torch, torch.nn as nn
sys.path.insert(0, os.environ.get('YOLOX_SRC', 'yolox_src'))
from yolox.models import YOLOX, YOLOPAFPN, YOLOXHead
DET = sys.argv[1] if len(sys.argv) > 1 else '.'
SIZE = int(os.environ.get('SIZE', 224)); BS = int(os.environ.get('BS', 64)); MAXN = 8
dev = 'cuda' if torch.cuda.is_available() else 'cpu'
MAX_STEPS = int(os.environ.get('MAX_STEPS', 0))  # smoke test

class Finder(nn.Module):
    """YOLOX-nano with the input normalisation built in. eval(): returns [N, 5] = x1, y1, x2, y2, score (224 px)."""
    def __init__(self):
        super().__init__()
        inc = [256, 512, 1024]
        self.m = YOLOX(YOLOPAFPN(0.33, 0.25, in_channels=inc, depthwise=True, act='silu'),
                       YOLOXHead(1, 0.25, in_channels=inc, depthwise=True, act='silu'))
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))
    def forward(self, x, targets=None):
        x = (x - self.mean) / self.std
        if self.training: return self.m(x, targets)
        o = self.m(x)[0]  # [anchors, 6] cx cy w h obj cls
        s = o[:, 4] * o[:, 5]
        return torch.stack([o[:, 0] - o[:, 2] / 2, o[:, 1] - o[:, 3] / 2, o[:, 0] + o[:, 2] / 2, o[:, 1] + o[:, 3] / 2, s], 1)

def load_set(name):
    j = json.load(open(os.path.join(DET, 'annotations', name + '.json'))); by = {}
    for a in j['annotations']: by.setdefault(a['image_id'], []).append(a['bbox'])
    return [(os.path.join(DET, name, im['file_name']), np.array(by.get(im['id'], []), np.float32).reshape(-1, 4), im['source']) for im in j['images']]

def letterbox(im, boxes, size=SIZE):
    h, w = im.shape[:2]; r = min(size / w, size / h); nw, nh = round(w * r), round(h * r); dx, dy = (size - nw) // 2, (size - nh) // 2
    out = np.full((size, size, 3), 114, np.uint8); out[dy:dy + nh, dx:dx + nw] = cv2.resize(im, (nw, nh), interpolation=cv2.INTER_AREA if r < 1 else cv2.INTER_LINEAR)
    b = boxes.copy(); b[:, 0] = b[:, 0] * r + dx; b[:, 1] = b[:, 1] * r + dy; b[:, 2:] *= r
    return out, b, (r, dx, dy)

def augment(im, boxes):
    """Gate-camera style: zoom in/out around a plate, shift, small tilt, light, blur, hand shake."""
    h, w = im.shape[:2]; boxes = boxes.copy()
    if random.random() < 0.5: im = im[:, ::-1].copy(); boxes[:, 0] = w - boxes[:, 0] - boxes[:, 2]
    # random crop/zoom: a window 45-100% of the picture (sometimes wider, padded), keeping at least one plate inside
    s = random.uniform(0.45, 1.25); cw, ch = w * s, h * s * random.uniform(0.8, 1.25)
    if len(boxes) and random.random() < 0.8:
        b = boxes[random.randrange(len(boxes))]; cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        x0 = cx - cw * random.uniform(0.2, 0.8); y0 = cy - ch * random.uniform(0.2, 0.8)
    else: x0 = random.uniform(min(0, w - cw), max(0, w - cw)); y0 = random.uniform(min(0, h - ch), max(0, h - ch))
    ang = random.uniform(-8, 8) if random.random() < 0.5 else 0
    out_w, out_h = int(round(cw)), int(round(ch))
    M = cv2.getRotationMatrix2D((cw / 2, ch / 2), ang, 1.0)
    T =np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], np.float32); R = np.vstack([M, [0, 0, 1]]).astype(np.float32); A = (R @ T)[:2]
    im = cv2.warpAffine(im, A, (out_w, out_h), borderValue=(114, 114, 114))
    nb = []
    for x, y, bw, bh in boxes:
        pts = np.array([[x, y, 1], [x + bw, y, 1], [x + bw, y + bh, 1], [x, y + bh, 1]], np.float32) @ A.T
        x1, y1 = pts.min(0); x2, y2 = pts.max(0); full = (x2 - x1) * (y2 - y1)
        cx1, cy1, cx2, cy2 = max(0, x1), max(0, y1), min(out_w, x2), min(out_h, y2)
        if cx2 - cx1 < 3 or cy2 - cy1 < 2 or (cx2 - cx1) * (cy2 - cy1) < 0.6 * full: continue  # mostly cut off: drop
        nb.append([cx1, cy1, cx2 - cx1, cy2 - cy1])
    boxes = np.array(nb, np.float32).reshape(-1, 4)
    f = im.astype(np.float32)
    if random.random() < 0.8: f = f * random.uniform(0.5, 1.4) + random.uniform(-40, 40)
    if random.random() < 0.3: f = f * np.array([random.uniform(0.85, 1.15) for _ in range(3)], np.float32)
    if random.random() < 0.25: f = cv2.GaussianBlur(f, (0, 0), random.uniform(0.4, 1.5))
    if random.random() < 0.25:
        k = random.choice([3, 5, 7]); kern = np.zeros((k, k), np.float32); kern[k // 2] = 1
        kern = cv2.warpAffine(kern, cv2.getRotationMatrix2D((k / 2 - .5, k / 2 - .5), random.uniform(0, 180), 1), (k, k)); f = cv2.filter2D(f, -1, kern / max(kern.sum(), 1e-6))
    if random.random() < 0.25: f = f + np.random.normal(0, random.uniform(2, 8), f.shape)
    return np.clip(f, 0, 255).astype(np.uint8), boxes

class Data(torch.utils.data.Dataset):
    def __init__(self, items, train): self.items, self.train = items, train
    def __len__(self): return len(self.items)
    def __getitem__(self, i):
        path, boxes, _ = self.items[i]; im = cv2.imread(path)
        if self.train: im, boxes = augment(im, boxes)
        im, b, _ = letterbox(im, boxes)
        x = torch.from_numpy(np.ascontiguousarray(im[:, :, ::-1].transpose(2, 0, 1))).float() / 255
        t = torch.zeros(MAXN, 5)
        for k, (bx, by, bw, bh) in enumerate(b[:MAXN]): t[k] = torch.tensor([0, bx + bw / 2, by + bh / 2, bw, bh])
        return x, t

def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1])); i = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i; return i / u if u > 0 else 0

def pick(rows, w, h, r, dx, dy, min_score=0.3):
    """The app's choice: sure, and near the middle (PlateFinder.find). rows: x1 y1 x2 y2 score in letterbox px."""
    best, bs = None, -1
    for x1, y1, x2, y2, s in rows:
        if s < min_score: continue
        x1, y1, x2, y2 = (x1 - dx) / r, (y1 - dy) / r, (x2 - dx) / r, (y2 - dy) / r
        cx, cy = (x1 + x2) / 2 / w - .5, (y1 + y2) / 2 / h - .5; sc = s - (cx * cx + cy * cy)
        if sc > bs: bs, best = sc, (x1, y1, x2, y2)
    return best

@torch.no_grad()
def evaluate(model, items):
    """Share of photos where the box the app would pick overlaps a true plate (IoU >= 0.5, and >= 0.7 = tight)."""
    model.eval(); hit5 = hit7 = 0
    for path, boxes, _ in items:
        im = cv2.imread(path); h, w = im.shape[:2]; lb, _, (r, dx, dy) = letterbox(im, boxes)
        x = torch.from_numpy(np.ascontiguousarray(lb[:, :, ::-1].transpose(2, 0, 1))).float()[None].to(dev) / 255
        rows = model(x).cpu().numpy(); rows = rows[rows[:, 4] >= 0.3]
        b = pick(rows, w, h, r, dx, dy)
        if b is None: continue
        best = max((iou(b, (x0, y0, x0 + bw, y0 + bh)) for x0, y0, bw, bh in boxes), default=0)
        hit5 += best >= 0.5; hit7 += best >= 0.7
    model.train(); return hit5 / len(items), hit7 / len(items)

if __name__ == '__main__':
    OUT, EPOCHS = sys.argv[2], int(sys.argv[3]); os.makedirs(OUT, exist_ok=True)
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    train = load_set('train'); val = load_set('val')
    # most of val is used for training too; model choice uses payals val (the reader's val plates) + the corner sets
    train += [v for v in val if v[2] in ('npds', 'merged')]; val = [v for v in val if v[2] not in ('npds', 'merged')]
    print('train photos', len(train), 'val photos', len(val), 'device', dev, flush=True)
    model = Finder()
    sd = torch.load(os.environ.get('WEIGHTS', 'weights/yolox_nano.pth'), map_location='cpu', weights_only=False)['model']
    own = model.m.state_dict(); keep = {k: v for k, v in sd.items() if k in own and own[k].shape == v.shape}
    model.m.load_state_dict(keep, strict=False); print('COCO weights loaded:', len(keep), 'of', len(own), flush=True)
    if os.environ.get('INIT'): model.load_state_dict(torch.load(os.environ['INIT'], map_location='cpu')); print('continuing from', os.environ['INIT'], flush=True)
    model.to(dev).train()
    dl = torch.utils.data.DataLoader(Data(train, True), batch_size=BS, shuffle=True, num_workers=int(os.environ.get('WORKERS', 8)), drop_last=True, persistent_workers=True)
    opt = torch.optim.SGD([{'params': [p for n, p in model.named_parameters() if p.ndim > 1], 'weight_decay': 5e-4},
                           {'params': [p for n, p in model.named_parameters() if p.ndim <= 1], 'weight_decay': 0}], lr=0.01, momentum=0.9, nesterov=True)
    total = EPOCHS * len(dl); warm = min(3 * len(dl), total // 5); LR = 0.01 * BS / 64 * float(os.environ.get('LR_SCALE', 1))
    lr_at = lambda s: LR * (s / warm) ** 2 if s < warm else LR * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, total - warm))))
    scaler = torch.amp.GradScaler(enabled=dev == 'cuda')
    LAST = os.path.join(OUT, 'finder.last.pt'); first, best = 0, -1
    if os.path.exists(LAST):
        st = torch.load(LAST, map_location=dev, weights_only=False); model.load_state_dict(st['model']); opt.load_state_dict(st['opt']); first, best = st['epoch'], st['best']
        print('continuing at epoch', first + 1, 'best', best, flush=True)
    step = first * len(dl)
    for ep in range(first, EPOCHS):
        t0 = time.time(); losses = []
        if ep == EPOCHS - 15: model.m.head.use_l1 = True  # YOLOX: L1 box loss for the last epochs
        for x, t in dl:
            for g in opt.param_groups: g['lr'] = lr_at(step)
            x, t = x.to(dev, non_blocking=True), t.to(dev, non_blocking=True)
            with torch.autocast(dev, enabled=dev == 'cuda'):
                loss = model(x, t)['total_loss']
            opt.zero_grad(set_to_none=True); scaler.scale(loss).backward(); scaler.step(opt); scaler.update()
            losses.append(loss.item()); step += 1
            if MAX_STEPS and step >= MAX_STEPS: break
        v5, v7 = evaluate(model, val)
        if v5 + v7 > best: best = v5 + v7; torch.save(model.state_dict(), os.path.join(OUT, 'finder_best.pt'))
        torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'epoch': ep + 1, 'best': best}, LAST)
        print(f'epoch {ep + 1}/{EPOCHS} loss {np.mean(losses):.3f} val found {v5:.3f} tight {v7:.3f} best {best:.3f} {time.time() - t0:.0f}s', flush=True)
        if MAX_STEPS and step >= MAX_STEPS: break
    os.remove(LAST); print('TRAINING DONE', flush=True)
