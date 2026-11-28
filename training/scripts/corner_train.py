# 4-corner plate model: finds the plate's four corners inside the box the finder found, so a plate seen from the side
# can be warped flat (a proper perspective fix, not only tilt + lean). Input = the app's "grown" box (box + 12% left/right,
# + 35% top/bottom), resized to 160 x 80, RGB 0..1. Output = 8 numbers: x,y of top-left, top-right, bottom-right,
# bottom-left, as fractions of that crop. Backbone: MobileNetV3-small (torchvision, BSD, ImageNet weights).
# Training pictures: real photos turned in 3D (yaw up to 55 deg, pitch 20, roll 12) around the plate, so the true corners
# are known. Corners come from the two hand-labelled corner sets (exact) and from plate boxes of straight-on photos.
# usage: corner_train.py DET_DIR OUT_DIR EPOCHS
import os, sys, json, math, random, time, cv2, numpy as np, torch, torch.nn as nn, torchvision
W, H = 160, 80; GX, GY = 0.12, 0.35  # the app's grown box
dev = 'cuda' if torch.cuda.is_available() else 'cpu'

class Corners(nn.Module):
    def __init__(self, pretrained=True):
        super().__init__()
        net = torchvision.models.mobilenet_v3_small(weights='IMAGENET1K_V1' if pretrained else None)
        self.features = net.features; self.head = nn.Sequential(nn.Linear(576, 128), nn.Hardswish(), nn.Linear(128, 8))
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))
        self.register_buffer('base', torch.from_numpy(base_quad().flatten()))
    def forward(self, x):
        f = self.features((x - self.mean) / self.std).mean((2, 3))
        return self.base + 0.25 * self.head(f)  # starts at "the box itself"; learns the correction

def base_quad():
    # corners of the plain box inside the grown crop, as fractions
    x0, x1 = GX / (1 + 2 * GX), (1 + GX) / (1 + 2 * GX); y0, y1 = GY / (1 + 2 * GY), (1 + GY) / (1 + 2 * GY)
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], np.float32)

def load(name, splits=None):
    j = json.load(open(os.path.join(sys.argv[1], 'annotations', name + '.json'))); ims = {i['id']: i for i in j['images']}; out = []
    for a in j['annotations']:
        im = ims[a['image_id']]
        if splits and im['source'] not in splits: continue
        x, y, w, h = a['bbox']
        if w < 14 or h < 6: continue
        if 'quad' not in a and h > 1.2 * w: continue  # picture turned sideways (Roboflow copies): no use for corners
        q = np.array(a['quad'], np.float32) if 'quad' in a else np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], np.float32)
        out.append((os.path.join(sys.argv[1], name, im['file_name']), q, 'quad' in a, a.get('text')))
    return out

def turn(im, q, yaw, pitch, roll, f_mult=1.6):
    """The plate (and the scene around it, as if flat) turned in 3D about the plate centre, seen by a camera at distance
    f = f_mult * picture size: near side larger, far side smaller and narrower (real side-angle view)."""
    h, w = im.shape[:2]; c = q.mean(0); f = f_mult * max(w, h)
    ry, rp, rr = map(math.radians, (yaw, pitch, roll))
    Ry = np.array([[math.cos(ry), 0, math.sin(ry)], [0, 1, 0], [-math.sin(ry), 0, math.cos(ry)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(rp), -math.sin(rp)], [0, math.sin(rp), math.cos(rp)]])
    Rz = np.array([[math.cos(rr), -math.sin(rr), 0], [math.sin(rr), math.cos(rr), 0], [0, 0, 1]])
    R = Rz @ Rx @ Ry; K = np.array([[f, 0, c[0]], [0, f, c[1]], [0, 0, 1]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], [0, 0, f]]) @ np.array([[1, 0, -c[0]], [0, 1, -c[1]], [0, 0, 1]])
    out = cv2.warpPerspective(im, Hm, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    qq = cv2.perspectiveTransform(q[None].astype(np.float64), Hm)[0]
    return out, qq.astype(np.float32)

def crop_for(im, q, jitter=0.0):
    """What the app gives the corner model: the finder's box (here: around the corners, with finder-like error), grown."""
    x1, y1 = q.min(0); x2, y2 = q.max(0); bw, bh = x2 - x1, y2 - y1
    if jitter:
        x1 += random.uniform(-jitter, jitter) * bw; x2 += random.uniform(-jitter, jitter) * bw
        y1 += random.uniform(-jitter, jitter) * 1.5 * bh; y2 += random.uniform(-jitter, jitter) * 1.5 * bh
        bw, bh = x2 - x1, y2 - y1
    gx1, gy1, gw, gh = x1 - GX * bw, y1 - GY * bh, bw * (1 + 2 * GX), bh * (1 + 2 * GY)
    A = np.array([[W / gw, 0, -gx1 * W / gw], [0, H / gh, -gy1 * H / gh]], np.float32)
    small = cv2.warpAffine(im, A, (W, H), flags=cv2.INTER_AREA if gw > 2 * W else cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    t = (q - [gx1, gy1]) / [gw, gh]
    return small, t.astype(np.float32), (gx1, gy1, gw, gh)

def light(x):
    f = x.astype(np.float32)
    if random.random() < 0.8: f = f * random.uniform(0.5, 1.4) + random.uniform(-40, 40)
    if random.random() < 0.3: f = cv2.GaussianBlur(f, (0, 0), random.uniform(0.3, 1.2))
    if random.random() < 0.3: f = f + np.random.normal(0, random.uniform(2, 8), f.shape)
    return np.clip(f, 0, 255).astype(np.uint8)

class Data(torch.utils.data.Dataset):
    def __init__(self, items, n): self.items, self.n = items, n
    def __len__(self): return self.n
    def __getitem__(self, i):
        path, q, exact, _ = random.choice(self.items); im = cv2.imread(path)
        if random.random() < 0.5: im = im[:, ::-1].copy(); w = im.shape[1]; q = q[[1, 0, 3, 2]].copy(); q[:, 0] = w - q[:, 0]
        if random.random() < 0.8:
            yaw = random.choice([-1, 1]) * random.uniform(0, 55); im, q = turn(im, q, yaw, random.uniform(-20, 20), random.uniform(-12, 12), random.uniform(1.0, 2.5))
        x, t, _ = crop_for(im, q, jitter=0.1)
        x = torch.from_numpy(np.ascontiguousarray(light(x)[:, :, ::-1].transpose(2, 0, 1))).float() / 255
        return x, torch.from_numpy(t.flatten()), torch.tensor(3.0 if exact else 1.0)

@torch.no_grad()
def pseudo_label(items, weights):
    m = Corners(False).to(dev); m.load_state_dict(torch.load(weights, map_location=dev)); m.eval(); out = []
    for k in range(0, len(items), 256):
        part = items[k:k + 256]; X, Xf, G = [], [], []
        for path, q, _, text in part:
            x, _, g = crop_for(cv2.imread(path), q); G.append(g)
            X.append(np.ascontiguousarray(x[:, :, ::-1].transpose(2, 0, 1))); Xf.append(np.ascontiguousarray(x[:, ::-1, ::-1].transpose(2, 0, 1)))
        P = m(torch.from_numpy(np.stack(X)).float().to(dev) / 255).cpu().numpy().reshape(-1, 4, 2)
        F = m(torch.from_numpy(np.stack(Xf)).float().to(dev) / 255).cpu().numpy().reshape(-1, 4, 2)
        F = F[:, [1, 0, 3, 2]]; F[:, :, 0] = 1 - F[:, :, 0]  # mirrored answer, mirrored back
        for (path, q, _, text), p, f, (gx, gy, gw, gh) in zip(part, P, F, G):
            pw = (p[1, 0] - p[0, 0] + p[2, 0] - p[3, 0]) / 2
            if pw <= 0.2 or np.linalg.norm(p - f, axis=1).mean() / pw > 0.03: continue  # unsure: skip
            out.append((path, ((p + f) / 2 * [gw, gh] + [gx, gy]).astype(np.float32), False, text))
    print('pseudo corners kept for', len(out), 'of', len(items), 'box-only plates', flush=True); return out

def corner_error(pred, t, q_img_w):
    """Mean corner distance in % of the plate's width."""
    p = pred.reshape(-1, 4, 2); g = t.reshape(-1, 4, 2); pw = (g[:, 1, 0] - g[:, 0, 0] + g[:, 2, 0] - g[:, 3, 0]) / 2
    return ((p - g).norm(dim=-1).mean(-1) / pw.clamp(min=1e-3)).mean().item() * 100

def fixed_set(items, seed, turned):
    random.seed(seed); np.random.seed(seed); X, T = [], []
    for path, q, exact, _ in items:
        im = cv2.imread(path)
        if turned: im, q = turn(im, q, random.choice([-1, 1]) * random.uniform(20, 50), random.uniform(-12, 12), random.uniform(-8, 8), 1.6)
        x, t, _ = crop_for(im, q, jitter=0.06)
        X.append(torch.from_numpy(np.ascontiguousarray(x[:, :, ::-1].transpose(2, 0, 1))).float() / 255); T.append(torch.from_numpy(t.flatten()))
    return torch.stack(X), torch.stack(T)

@torch.no_grad()
def evaluate(model, sets):
    model.eval(); out = {}
    for name, (X, T) in sets.items():
        P = torch.cat([model(X[i:i + 256].to(dev)).cpu() for i in range(0, len(X), 256)])
        out[name] = (corner_error(P, T, None), corner_error(torch.from_numpy(np.tile(base_quad().flatten(), (len(T), 1))), T, None))
    model.train(); return out

if __name__ == '__main__':
    OUT, EPOCHS = sys.argv[2], int(sys.argv[3]); os.makedirs(OUT, exist_ok=True); random.seed(0); torch.manual_seed(0)
    train = load('train') + load('val', ('npds', 'merged'))
    exact = [t for t in train if t[2]]
    if os.environ.get('PSEUDO'):  # stage 2: corners of the box-only plates, as read by the stage-1 model (only stable ones)
        train = exact * 4 + pseudo_label([t for t in train if not t[2]], os.environ['PSEUDO'])
    else: train = exact  # stage 1: hand-labelled corners only
    real_val = load('val', ('kp1', 'kp2')) + load('test', ('kp1',))
    sets = {'real corners (hand-labelled, val+test)': fixed_set(real_val, 1, False),
            'real corners, turned 20-50 deg': fixed_set(real_val, 2, True),
            '163 test plates, turned 20-50 deg': fixed_set(load('test', ('payals',)), 3, True)}
    print('train plates', len(train), '| exact-corner plates', len(exact), '| val', {k: len(v[0]) for k, v in sets.items()}, flush=True)
    model = Corners().to(dev)
    if os.environ.get('INIT'): model.load_state_dict(torch.load(os.environ['INIT'], map_location=dev)); print('continuing from', os.environ['INIT'], flush=True)
    n = int(os.environ.get('PER_EPOCH', 40000)); BS = int(os.environ.get('BS', 128))
    dl = torch.utils.data.DataLoader(Data(train, n), batch_size=BS, num_workers=int(os.environ.get('WORKERS', 8)), drop_last=True, persistent_workers=True,
                                     worker_init_fn=lambda k: (random.seed(torch.initial_seed() % 2**31 + k), np.random.seed((torch.initial_seed() + k) % 2**31)))
    LR = 2e-3 * float(os.environ.get('LR_SCALE', 1))
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, LR, total_steps=EPOCHS * len(dl), pct_start=0.1)
    best = 1e9; MAX = int(os.environ.get('MAX_STEPS', 0)); step = 0
    for ep in range(EPOCHS):
        t0 = time.time(); ls = []
        for x, t, wgt in dl:
            x, t, wgt = x.to(dev), t.to(dev), wgt.to(dev)
            p = model(x); loss = (nn.functional.smooth_l1_loss(p, t, reduction='none', beta=0.02).mean(1) * wgt).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step(); ls.append(loss.item()); step += 1
            if MAX and step >= MAX: break
        r = evaluate(model, sets); score = sum(v[0] for v in r.values())
        if score < best: best = score; torch.save(model.state_dict(), os.path.join(OUT, 'corners_best.pt'))
        print(f'epoch {ep + 1}/{EPOCHS} loss {np.mean(ls):.4f} ' + ' | '.join(f'{k}: {v[0]:.1f}% (box alone {v[1]:.1f}%)' for k, v in r.items()) + f' {time.time() - t0:.0f}s', flush=True)
        if MAX and step >= MAX: break
    print('TRAINING DONE', flush=True)
