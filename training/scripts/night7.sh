#!/bin/bash
# Runpod round for moving / blurry plates (28 Nov 2026), run by pod_boot.sh with JOB=night7:
#  1. ~1.5 lakh blur-heavy synthetic Indian plates (synth_many.sh), then the reader retrain starts at once (from v4, chosen on
#     plain + straightened + turned + motion-blurred val plates);
#  2. meanwhile CCPD (MIT, ~3 lakh parking photos with exact plate corners) is downloaded and ~40k photos added to training;
#  3. the finder and the 4-corner model are fine-tuned from last night's models with CCPD added.
# Every model is only kept after testing against the current one on the 163 test plates (done afterwards on a CPU).
A=${A:-/workspace}; cd $A; P=$A/scripts; M=$A/repo/training/models
log() { echo "$(date +%H:%M:%S) $*" | tee -a $A/night.log; }
log "setup"
pip install -q opencv-python-headless loguru thop tabulate psutil onnx pycocotools gdown >> setup.log 2>&1 || log "pip (torch side) FAILED"
[ -d $A/tfenv ] || { python -m venv $A/tfenv && $A/tfenv/bin/pip install -q "tensorflow[and-cuda]==2.21.0" "keras==3.15.1" "fast-plate-ocr[train,onnx]==1.1.0" onnxruntime opencv-python-headless >> setup.log 2>&1 || log "pip (tf side) FAILED"; }
python -c "import torch; print('torch', torch.__version__, torch.cuda.get_device_name(0))" 2>&1 | tee -a night.log
$A/tfenv/bin/python -c "from fast_plate_ocr.train.model import layers; import onnxruntime, tensorflow as tf; print('reader packages ok, gpus', len(tf.config.list_physical_devices('GPU')))" 2>&1 | tail -1 | tee -a night.log
NC=$(nproc); log "cpus $NC"

log "1. blur-heavy synthetic plates"
J=$(( NC > 16 ? 16 : NC )) bash $P/synth_many.sh $A/anpr/ocrdata ${SYNTH2_N:-180000} 1 2>&1 | tail -1 | tee -a night.log
log "1. reader retrain (from v4) starts"
(cd $A/anpr && TF_FORCE_GPU_ALLOW_GROWTH=true SELECT=mixblur BLUR_P=${BLUR_P:-0.5} BLUR_MAX=${BLUR_MAX:-11} STRAIGHT=0.5 CORNER_ERR=0.024 SYNTH=${SYNTH:-30000} \
  RESUME=$A/anpr/reader_v4.keras OUT=reader_v5.keras PEAK_LR=${READER_LR:-1e-4} $A/tfenv/bin/python -u $P/train.py $A/anpr ${READER_EPOCHS:-30} > $A/reader.log 2>&1 \
  || echo "$(date +%H:%M:%S) reader FAILED" >> $A/night.log; echo "$(date +%H:%M:%S) reader done: $(grep FINAL $A/reader.log)" >> $A/night.log) &
RP=$!

log "2. CCPD download"
CC=0
if timeout 2h gdown -q 1rdEsCUcIUaYOVRkx5IMTRNA7PcGMmSgc -O $A/ccpd.tar.xz >> setup.log 2>&1 && [ -s $A/ccpd.tar.xz ]; then
  log "CCPD downloaded: $(du -h $A/ccpd.tar.xz | cut -f1)"; mkdir -p $A/ccpd && tar xJf $A/ccpd.tar.xz -C $A/ccpd && rm -f $A/ccpd.tar.xz && log "CCPD extracted: $(du -sh $A/ccpd | cut -f1)"
  python -I $P/ccpd_prep.py $A/ccpd $A/det ${CCPD_SCALE:-1.0} 2>&1 | tee -a night.log && CC=1
else log "CCPD download FAILED (Google Drive): finder and corner model are trained without it"; fi

log "3. finder + corner model fine-tune (CCPD added: $CC)"
YOLOX_SRC=$A/yolox_src WEIGHTS=$A/weights/yolox_nano.pth INIT=$M/finder_yolox224.pt LR_SCALE=0.3 BS=64 WORKERS=$((NC / 3)) \
  python -u $P/yolox_train.py $A/det $A/runs/finder ${FINDER_EPOCHS:-30} > finder.log 2>&1 || log "finder FAILED" &
FP=$!
INIT=$M/corners_v1.pt LR_SCALE=0.5 BS=128 WORKERS=$((NC / 3)) PER_EPOCH=40000 python -u $P/corner_train.py $A/det $A/runs/corners1 ${CORNER_EPOCHS:-20} > corners1.log 2>&1 || log "corners FAILED"
log "corners done: $(grep '^epoch' corners1.log | tail -1)"
wait $FP; log "finder done: $(grep '^epoch' finder.log | tail -1)"
wait $RP
log "ALL DONE"
