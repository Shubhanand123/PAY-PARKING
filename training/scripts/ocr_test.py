import sys, glob, os, time, re
from fast_plate_ocr import LicensePlateRecognizer
root = sys.argv[1]
files = [(f, os.path.basename(os.path.dirname(f))) for f in glob.glob(os.path.join(root, '*', '*.jpg'))]
files = [x for x in files if x[1] != 'Unlabeled']
norm = lambda s: re.sub(r'[^A-Z0-9]', '', s.upper())
for name in sys.argv[2:]:
    try:
        m = LicensePlateRecognizer(name)
    except Exception as e:
        print(name, 'LOAD FAIL', e); continue
    m.run(files[0][0])
    ok = near = 0; t0 = time.perf_counter(); wrong = []
    for f, label in files:
        out = m.run(f)
        txt = out[0] if isinstance(out, (list, tuple)) else out
        txt = getattr(txt, 'plate', txt)
        p = norm(str(txt))
        if p == label: ok += 1
        elif sum(a != b for a, b in zip(p, label)) + abs(len(p) - len(label)) <= 1: near += 1; wrong.append((label, p))
        else: wrong.append((label, p))
    dt = (time.perf_counter() - t0) / len(files) * 1000
    print(f'{name}: exact {ok}/{len(files)} = {ok/len(files):.0%}, 1 char off {near}, {dt:.1f} ms/plate (this computer)')
    print('   sample misses:', wrong[:6])
