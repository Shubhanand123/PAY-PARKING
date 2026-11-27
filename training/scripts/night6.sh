#!/bin/bash
# Runpod GPU night: (a) YOLOX finder 224 + (b) 4-corner model stage 1, in parallel; (b) stage 2; (c) reader on straightened crops.
# Expects in $A: det/ (det_prep.py output), anpr/ocrdata/ (plates.tgz + synth.py), yolox_src/, weights/yolox_nano.pth, scripts/.
# Testing against the app's current models is done afterwards on a CPU (finder_eval.py, pipeline_eval.py, export_eval.py).
A=${A:-/workspace}; cd $A; P=$A/scripts
log() { echo "$(date +%H:%M:%S) $*" | tee -a $A/night.log; }
set -o pipefail
log "setup"
pip install -q opencv-python-headless loguru thop tabulate psutil onnx pycocotools >> setup.log 2>&1 || log "pip (torch side) FAILED"
[ -d $A/tfenv ] || { python -m venv $A/tfenv && $A/tfenv/bin/pip install -q "tensorflow[and-cuda]==2.21.0" "keras==3.15.1" "fast-plate-ocr[train]==1.1.0" opencv-python-headless >> setup.log 2>&1 || log "pip (tf side) FAILED"; }
python -c "import torch; print('torch', torch.__version__, torch.cuda.get_device_name(0))" 2>&1 | tee -a night.log
$A/tfenv/bin/python -c "import tensorflow as tf; print('tf gpus', tf.config.list_physical_devices('GPU'))" 2>&1 | grep gpus | tee -a night.log
NC=$(nproc); log "cpus $NC"
log "(a) finder + (b) corners stage 1"
YOLOX_SRC=$A/yolox_src WEIGHTS=$A/weights/yolox_nano.pth BS=64 WORKERS=$((NC / 2)) python -u $P/yolox_train.py $A/det $A/runs/finder ${FINDER_EPOCHS:-150} > finder.log 2>&1 &
FP=$!
if [ -n "$SKIP_CORNERS" ]; then log "corner model trained elsewhere: skipped here"; else
BS=128 WORKERS=$((NC / 2)) PER_EPOCH=40000 python -u $P/corner_train.py $A/det $A/runs/corners1 ${CORNER_EPOCHS:-25} > corners1.log 2>&1 || log "corners stage 1 FAILED"
log "corners stage 1 done: $(tail -2 corners1.log | head -1)"
PSEUDO=$A/runs/corners1/corners_best.pt BS=128 WORKERS=$((NC / 2)) PER_EPOCH=40000 python -u $P/corner_train.py $A/det $A/runs/corners2 ${CORNER_EPOCHS:-25} > corners2.log 2>&1 || log "corners stage 2 FAILED"
log "corners stage 2 done: $(tail -2 corners2.log | head -1)"; fi
# the reader practises with the corner error measured on real hand-labelled plates turned 20-50 deg (stage 2, best epoch)
[ -n "$SKIP_CORNERS" ] && ERR=$CORNER_ERR || ERR=$(python - <<'E'
import re
best = min((sum(map(float, re.findall(r': ([\d.]+)% \(box', l))), float(re.findall(r'turned 20-50 deg: ([\d.]+)%', l)[0])) for l in open('corners2.log') if l.startswith('epoch'))
print(round(best[1] / 100, 3))
E
)
log "corner error used for reader practice: ${ERR:-0.03}"
log "(c) reader on straightened crops, from v4"
cd $A/anpr && TF_FORCE_GPU_ALLOW_GROWTH=true STRAIGHT=0.5 CORNER_ERR=${ERR:-0.03} RESUME=$A/anpr/reader_v4.keras OUT=reader_v5.keras PEAK_LR=2e-4 \
  $A/tfenv/bin/python -u $P/train.py $A/anpr ${READER_EPOCHS:-20} > $A/reader.log 2>&1 || log "reader FAILED"
cd $A; log "reader done: $(grep FINAL reader.log)"
wait $FP || log "finder FAILED"; log "finder done: $(grep '^epoch' finder.log | tail -1)"
log "ALL DONE"
