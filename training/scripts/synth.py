# Synthetic Indian number plates: random valid numbers (more Goa/GA), one- and two-line layouts,
# white (private) and yellow (commercial) plates, HSRP "IND" strip, bold sans fonts, then blur / tilt / glare / noise.
import os, sys, csv, random, numpy as np, cv2, glob
from PIL import Image, ImageDraw, ImageFont
out, n = sys.argv[1], int(sys.argv[2]); random.seed(7); np.random.seed(7)
os.makedirs(os.path.join(out, 'synth'), exist_ok=True)
fonts = [f for f in glob.glob('/usr/share/fonts/truetype/**/*.ttf', recursive=True) if any(k in f for k in ('DejaVuSans-Bold', 'DejaVuSansCondensed-Bold', 'LiberationSans-Bold.', 'LiberationSansNarrow-Bold', 'DejaVuSansMono-Bold', 'LiberationMono-Bold.')) and 'Oblique' not in f and 'Italic' not in f]
STATES = 'AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TR UP UK WB'.split()
L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
def number():
    if random.random() < 0.05: return f'{random.randint(21,26)}BH{random.randint(0,9999):04d}{random.choice(L)}{random.choice(L) if random.random()<.5 else ""}'
    st = 'GA' if random.random() < 0.35 else random.choice(STATES)
    d = random.randint(1, 99 if st != 'GA' else 12)
    mid = ''.join(random.choice(L) for _ in range(random.choice([0, 1, 2, 2, 2, 3])))
    return f'{st}{d:02d}{mid}{random.randint(1, 9999):04d}'
def parts(p):
    if 'BH' in p[2:4]: return [p[:2], 'BH', p[4:8], p[8:]]
    import re; m = re.match(r'^([A-Z]{2})(\d{2})([A-Z]*)(\d{4})$', p); return [g for g in m.groups() if g]
def render(p):
    yellow = random.random() < 0.3
    bg = (random.randint(200, 255),) * 3 if not yellow else (random.randint(225, 255), random.randint(185, 225), random.randint(0, 40))
    two = random.random() < 0.25
    font = ImageFont.truetype(random.choice(fonts), random.randint(44, 60))
    ps = parts(p); text = ' '.join(ps) if random.random() < 0.8 else ''.join(ps)
    lines = [' '.join(ps[:2]), ' '.join(ps[2:])] if two else [text]
    ws = [font.getbbox(t)[2] for t in lines]; lh = font.getbbox('A8')[3]
    strip = random.random() < 0.6
    W = max(ws) + 40 + (26 if strip else 0); H = lh * len(lines) + 24 + 10 * (len(lines) - 1)
    img = Image.new('RGB', (W, H), tuple(int(c) for c in bg)); dr = ImageDraw.Draw(img)
    dr.rectangle([2, 2, W - 3, H - 3], outline=(15, 15, 15), width=random.randint(2, 4))
    x0 = 20 + (26 if strip else 0)
    if strip:
        dr.rectangle([5, 5, 26, H - 6], fill=(30, 60, 170)); sf = ImageFont.truetype(fonts[0], 10); dr.text((8, H - 22), 'IND', fill='white', font=sf)
    y = 12
    for t, w in zip(lines, ws):
        dr.text((x0 + (max(ws) - w) // 2, y - font.getbbox(t)[1] + 2), t, fill=(random.randint(0, 30),) * 3, font=font); y += lh + 10
    a = np.array(img)[:, :, ::-1].copy()
    # camera effects
    h, w = a.shape[:2]; j = 0.06
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]]); dst = (src + np.random.uniform(-j, j, (4, 2)) * np.array([w, h])).astype(np.float32)
    a = cv2.warpPerspective(a, cv2.getPerspectiveTransform(src, dst), (w, h), borderMode=cv2.BORDER_REPLICATE)
    if random.random() < 0.5: a = cv2.GaussianBlur(a, (0, 0), random.uniform(0.3, 1.6))
    if random.random() < 0.3:  # glare
        gx = random.randint(0, w); g = np.clip(1 - np.abs(np.arange(w) - gx) / (w * 0.25), 0, 1) * random.uniform(40, 110); a = np.clip(a + g[None, :, None], 0, 255).astype(np.uint8)
    a = np.clip(a * random.uniform(0.55, 1.2) + np.random.normal(0, random.uniform(2, 10), a.shape), 0, 255).astype(np.uint8)
    s = random.uniform(0.35, 1.0); a = cv2.resize(a, (max(24, int(w * s)), max(12, int(h * s))))
    pad = [random.randint(0, 8) for _ in range(4)]
    return cv2.copyMakeBorder(a, pad[0], pad[1], pad[2], pad[3], cv2.BORDER_REPLICATE)
rows = []
for i in range(n):
    p = number()
    if len(p) > 10: continue
    name = f'synth/s{i:05d}.jpg'; cv2.imwrite(os.path.join(out, name), render(p), [cv2.IMWRITE_JPEG_QUALITY, random.randint(55, 92)]); rows.append((name, p))
with open(os.path.join(out, 'synth.csv'), 'w', newline='') as fh: w = csv.writer(fh); w.writerow(['image_path', 'plate_text']); w.writerows(rows)
print(len(rows), 'synthetic plates')
