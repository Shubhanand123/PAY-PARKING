# corners_best.pt -> ONNX. Input 'band' [1, 3, 80, 160] RGB 0..1 (the app's grown box), output 'corners' [1, 8] as fractions.
import sys, os, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from corner_train import Corners, W, H
m = Corners(False); m.load_state_dict(torch.load(sys.argv[1], map_location='cpu')); m.eval()
torch.onnx.export(m, torch.zeros(1, 3, H, W), sys.argv[2], input_names=['band'], output_names=['corners'], opset_version=17, dynamo=False)
print('corner onnx', sys.argv[2], os.path.getsize(sys.argv[2]) // 1024, 'KB')
