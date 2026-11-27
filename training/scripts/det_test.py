import sys, glob, os, time, cv2
from open_image_models import LicensePlateDetector
root = sys.argv[1]
imgs = sorted(glob.glob(root + '/valid/images/*.jpg') + glob.glob(root + '/test/images/*.jpg'))
def gts(img):
    lab = img.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
    h, w = cv2.imread(img).shape[:2]; out = []
    for line in open(lab):
        c, x, y, bw, bh = map(float, line.split()[:5])
        if int(c) == 0: out.append(((x - bw/2) * w, (y - bh/2) * h, (x + bw/2) * w, (y + bh/2) * h))
    return out
def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy; u = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - i
    return i / u if u else 0
for name in sys.argv[2:]:
    det = LicensePlateDetector(detection_model=name, conf_thresh=0.3)
    frames = [cv2.imread(i) for i in imgs]
    det.predict(frames[0])
    found = total = extra = 0; t0 = time.perf_counter()
    for img, fr in zip(imgs, frames):
        boxes = [(d.bounding_box.x1, d.bounding_box.y1, d.bounding_box.x2, d.bounding_box.y2) for d in det.predict(fr)]
        g = gts(img); total += len(g)
        hit = [any(iou(b, x) >= 0.4 for x in g) for b in boxes]
        found += sum(any(iou(b, x) >= 0.4 for b in boxes) for x in g); extra += hit.count(False)
    dt = (time.perf_counter() - t0) / len(imgs) * 1000
    print(f'{name}: found {found}/{total} plates = {found/total:.0%}, wrong boxes {extra}, {dt:.0f} ms/photo (this computer)')
