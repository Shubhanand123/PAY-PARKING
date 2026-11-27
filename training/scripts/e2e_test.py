import sys, glob, os, time, re, cv2, yaml
sys.path.insert(0, os.path.dirname(__file__))
from open_image_models import LicensePlateDetector
from fast_plate_ocr import LicensePlateRecognizer
root, detname, ocrname = sys.argv[1:4]
names = yaml.safe_load(open(root + '/data.yaml'))['names']
STATES=set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD=re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$')
L={'0':'O','1':'I','5':'S','8':'B','2':'Z','6':'G','4':'A'}; D={'O':'0','I':'1','S':'5','B':'8','Z':'2','D':'0','Q':'0','G':'6'}
def fix(p):
    if len(p)<6: return p
    a=list(p)
    for i in range(2): a[i]=L.get(a[i],a[i])
    for i in range(2,4): a[i]=D.get(a[i],a[i])
    for i in range(len(a)-4,len(a)): a[i]=D.get(a[i],a[i])
    return ''.join(a)
norm=lambda s: re.sub(r'[^A-Z0-9]','',s.upper())
det = LicensePlateDetector(detection_model=detname, conf_thresh=0.3); ocr = LicensePlateRecognizer(ocrname)
imgs = sorted(glob.glob(root + '/valid/images/*.jpg') + glob.glob(root + '/test/images/*.jpg'))
total=found=read=readfix=0; tdet=tocr=0; ncrop=0
def iou(a,b):
    ix=max(0,min(a[2],b[2])-max(a[0],b[0])); iy=max(0,min(a[3],b[3])-max(a[1],b[1])); i=ix*iy
    u=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i; return i/u if u else 0
for p in imgs:
    im = cv2.imread(p); h, w = im.shape[:2]
    gt = []
    for line in open(p.replace('/images/','/labels/').rsplit('.',1)[0]+'.txt'):
        c,x,y,bw,bh = map(float,line.split()[:5]); lab = str(names[int(c)])
        if not STD.match(lab) or lab[:2] not in STATES: continue  # only proper plate labels
        gt.append(((x-bw/2)*w,(y-bh/2)*h,(x+bw/2)*w,(y+bh/2)*h,lab))
    if not gt: continue
    t0=time.perf_counter(); ds = det.predict(im); tdet += time.perf_counter()-t0
    boxes=[(d.bounding_box.x1,d.bounding_box.y1,d.bounding_box.x2,d.bounding_box.y2) for d in ds]
    for g in gt:
        total+=1
        best=max(boxes,key=lambda b: iou(b,g),default=None)
        if best is None or iou(best,g)<0.3: continue
        found+=1
        x1,y1,x2,y2=[int(v) for v in best]; crop=im[max(0,y1):y2,max(0,x1):x2]
        if not crop.size: continue
        t0=time.perf_counter(); o=ocr.run(crop); tocr+=time.perf_counter()-t0; ncrop+=1
        t=o[0] if isinstance(o,(list,tuple)) else o; r=norm(str(getattr(t,'plate',t)))
        read += r==g[4]; readfix += fix(r)==g[4]
print(f'{detname} + {ocrname}: plates {total}; found {found/total:.0%}; read exactly {read/total:.0%} (with plate rules {readfix/total:.0%}); finder {tdet/len(imgs)*1000:.0f} ms, reader {tocr/max(1,ncrop)*1000:.1f} ms (this computer)')
