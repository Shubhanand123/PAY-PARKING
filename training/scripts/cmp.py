import os,sys,glob,numpy as np,cv2,onnxruntime as ort
os.environ['TF_CPP_MIN_LOG_LEVEL']='3'
import tensorflow as tf
M='/home/user/PAY-PARKING/training/models'
imgs=sorted(glob.glob('/tmp/claude-0/-home-user/72915f6d-0a4c-50cf-ba97-5b1824b4552c/scratchpad/anpr/ocrdata/test/*'))[:30]
for n,size in (('finder_yolox224',(224,224)),('corners_v1',(160,80))):
    o=ort.InferenceSession(f'{M}/{n}.onnx',providers=['CPUExecutionProvider']); inn=o.get_inputs()[0].name
    it=tf.lite.Interpreter(model_path=f'out_{n}/{n}_float32.tflite',num_threads=1); it.allocate_tensors()
    d=it.get_input_details()[0]; print(n,'tflite input',d['shape'],d['dtype'],'outputs',[x['shape'] for x in it.get_output_details()])
    md=0
    for f in imgs:
        im=cv2.resize(cv2.cvtColor(cv2.imread(f),cv2.COLOR_BGR2RGB),size).astype(np.float32)/255
        nchw=im.transpose(2,0,1)[None]; a=o.run(None,{inn:nchw})[0]
        it.set_tensor(d['index'],im[None]); it.invoke(); b=it.get_tensor(it.get_output_details()[0]['index'])
        md=max(md,float(np.abs(a.reshape(-1)-b.reshape(-1)).max()))
    print(n,'max difference onnx vs tflite',md)
