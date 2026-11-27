# Stores large float32 weights as float16 and adds a Cast back to float32 at load time (math unchanged, file ~half).
import sys, onnx, numpy as np
from onnx import helper, numpy_helper, TensorProto
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src); g = m.graph; casts = []; keep = []
for init in g.initializer:
    a = numpy_helper.to_array(init)
    if a.dtype == np.float32 and a.size >= 256:
        h = numpy_helper.from_array(a.astype(np.float16), init.name + '__fp16'); keep.append(h)
        casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
    else: keep.append(init)
del g.initializer[:]; g.initializer.extend(keep)
nodes = list(g.node); del g.node[:]; g.node.extend(casts + nodes)
onnx.checker.check_model(m); onnx.save(m, dst)
