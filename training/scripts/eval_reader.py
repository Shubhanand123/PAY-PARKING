import os, sys, csv, re, time, numpy as np, cv2, onnxruntime as ort
os.environ['TF_CPP_MIN_LOG_LEVEL']='3'
import tensorflow as tf
A=sys.argv[1]; D=os.path.join(A,'ocrdata'); ALPHA='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
STATES=set('AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split())
STD=re.compile(r'^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$'); valid=lambda p: bool(STD.match(p)) and p[:2] in STATES
rows=list(csv.DictReader(open(os.path.join(D,'test.csv'))))
X=np.stack([cv2.resize(cv2.cvtColor(cv2.imread(os.path.join(D,r['image_path'])),cv2.COLOR_BGR2RGB),(128,64)) for r in rows]).astype(np.uint8); T=[r['plate_text'] for r in rows]
o=ort.InferenceSession(sys.argv[2],providers=['CPUExecutionProvider'])
it=tf.lite.Interpreter(model_path=sys.argv[3],num_threads=1); it.allocate_tensors(); ii=it.get_input_details()[0]['index']; oi=it.get_output_details()[0]['index']
def tfl(x): it.set_tensor(ii,x); it.invoke(); return it.get_tensor(oi)
for name,run in (('onnx v4',lambda x:o.run(None,{'input':x})[0]),('tflite',tfl)):
    t0=time.perf_counter(); P=np.concatenate([run(X[i:i+1]) for i in range(len(X))]); ms=(time.perf_counter()-t0)/len(X)*1000
    tx=[''.join(ALPHA[k] for k in p.argmax(-1)).replace('_','') for p in P]
    cf=[min(p.max(-1)[[ALPHA[k]!='_' for k in p.argmax(-1)]]) if t else 0 for p,t in zip(P,tx)]
    take=[i for i in range(len(T)) if cf[i]>=.8 and valid(tx[i])]
    print(f"{name}: exact {np.mean([a==b for a,b in zip(tx,T)]):.1%} | sure(80%) used {len(take)/len(T):.0%} wrong {sum(tx[i]!=T[i] for i in take)} | {ms:.1f} ms")
