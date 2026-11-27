import sys, glob, os, re, time
from fast_plate_ocr import LicensePlateRecognizer
STATES=set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD=re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{1,4}$')
L={'0':'O','1':'I','5':'S','8':'B','2':'Z','6':'G','4':'A'}; D={'O':'0','I':'1','S':'5','B':'8','Z':'2','D':'0','Q':'0','G':'6','A':'4','T':'1'}
def fix(p):
    if len(p)<6: return p
    a=list(p)
    for i in range(2): a[i]=L.get(a[i],a[i])
    for i in range(2,4): a[i]=D.get(a[i],a[i])
    for i in range(len(a)-4,len(a)): a[i]=D.get(a[i],a[i])
    return ''.join(a)
def valid(p): m=STD.match(p); return bool(m and m.group(1) in STATES)
norm=lambda s: re.sub(r'[^A-Z0-9]','',s.upper())
files=[(f,os.path.basename(os.path.dirname(f))) for f in glob.glob(os.path.join(sys.argv[1],'*','*.jpg'))]
files=[x for x in files if x[1]!='Unlabeled']
m=LicensePlateRecognizer(sys.argv[2])
raw=fixed=validc=0
for f,lab in files:
    out=m.run(f); t=out[0] if isinstance(out,(list,tuple)) else out; p=norm(str(getattr(t,'plate',t)))
    q=fix(p); raw+=p==lab; fixed+=q==lab; validc+=valid(q)
n=len(files); print(f'{sys.argv[2]}: as read {raw/n:.0%}, with plate rules {fixed/n:.0%}, looks like a valid plate {validc/n:.0%}')
