#!/bin/bash
# Runs by itself when the Runpod pod starts (pod start command, pinned to a commit of this repo). No SSH needed:
# builds the data, trains with night6.sh, and shares only /workspace/out (logs + trained models) read-only on port 8000.
# Env (set on the pod): REPO_COMMIT, RF_PAYALS, RF_MERGED, RF_KP1, RF_KP2 (Roboflow export download links, CC BY 4.0 sets).
A=/workspace; O=$A/out; mkdir -p $O; cd $A
exec > >(tee -a $O/boot.log) 2>&1
# read-only file server for logs/models: restarts if it dies, and is the last thing the out-of-memory killer picks
(cd $O && while true; do python -m http.server 8000 >/dev/null 2>&1 & echo -1000 > /proc/$!/oom_score_adj 2>/dev/null; wait $!; sleep 3; done) &
log() { echo "$(date +%H:%M:%S) $*"; }
fail() { log "FAILED: $*"; touch $O/FAILED; sleep 1800; command -v runpodctl && runpodctl stop pod $RUNPOD_POD_ID; exit 1; }
log "boot, commit $REPO_COMMIT"
# a machine whose GPU does not work would train on the CPU for hours: stop at once
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
python -c "import torch; assert torch.cuda.is_available(); x = torch.ones(1024, 1024, device='cuda'); print('GPU ok:', torch.cuda.get_device_name(0), float((x @ x).sum()))" \
  || { log "FAILED: GPU not usable"; touch $O/FAILED; sleep 600; command -v runpodctl && runpodctl stop pod $RUNPOD_POD_ID; exit 1; }
apt-get update -qq >/dev/null && apt-get install -y -qq fonts-dejavu-core fonts-liberation >/dev/null || log "fonts install failed"
git clone -q https://github.com/Shubhanand123/pay-parking repo && git -C repo checkout -q $REPO_COMMIT || fail "clone"
cp -r repo/training/scripts $A/scripts
pip install -q opencv-python-headless pillow loguru thop tabulate psutil onnx pycocotools > $A/pip.log 2>&1 || fail "pip"
# reader data: real crops from the repo + synthetic plates
mkdir -p anpr/ocrdata && cat repo/training/data/plates.tgz.part* | tar xzf - -C anpr/ocrdata || fail "plates.tgz"
tar xzf repo/training/data/nolicence_plates.tgz -C anpr/ocrdata || fail "nolicence_plates.tgz"  # HR-LR side-angle crops (owner's decision)
[ -n "$KAGGLE" ] && { cat repo/training/data/kaggle.tgz.part* | tar xzf - -C anpr/ocrdata || fail "kaggle.tgz"; log "Kaggle set added"; }
cp repo/training/models/reader_v4.keras anpr/
python -I scripts/synth.py $A/anpr/ocrdata ${SYNTH_N:-20000} || fail "synth"
cmp <(cut -d, -f2 anpr/ocrdata/synth.csv) <(cut -d, -f2 repo/training/labels/synth.csv) && log "synthetic labels identical" || log "synthetic labels differ (fonts?)"
# photo data for the finder and the corner model (not needed for a reader-only round)
if [ -z "$SKIP_PHOTOS" ]; then
mkdir -p raw; get() {  # up to 4 tries: a server sometimes answers with an error page instead of the zip
  mkdir -p raw/$1; for try in 1 2 3 4; do
    curl -sL --retry 3 -o raw/$1/d.zip "$2"
    # Mendeley sometimes answers with {"status":"OK","url":"<the file on S3>"}: follow it
    u=; [ "$(stat -c%s raw/$1/d.zip 2>/dev/null || echo 0)" -lt 10000 ] && u=$(python -c "import json; print(json.load(open('raw/$1/d.zip')).get('url', ''))" 2>/dev/null); [ -n "$u" ] && curl -sL --retry 3 -o raw/$1/d.zip "$u"
    python -c "import zipfile,sys; sys.exit(not zipfile.is_zipfile('raw/$1/d.zip'))" && (cd raw/$1 && python -m zipfile -e d.zip . && rm d.zip) && return 0
    log "download $1: try $try failed ($(head -c 120 raw/$1/d.zip 2>/dev/null | tr -dc '[:print:]'))"; sleep $((try * 20)); done
  fail "download $1"; }
get payals "$RF_PAYALS"; get merged "$RF_MERGED"; get kp1 "$RF_KP1"; get kp2 "$RF_KP2"
get npds "${NPDS_URL:-https://data.mendeley.com/public-files/datasets/sxrnr7hwtk/files/dbdc1d8c-8e79-464e-920d-6e298b31bcc7/file_downloaded}"  # NPDS_URL: e.g. the file on S3 that Mendeley points to
python -I scripts/det_prep.py raw det | tee $O/det_prep.txt || fail "det_prep"
git clone -q --depth 1 https://github.com/Megvii-BaseDetection/YOLOX yolox_src || fail "yolox clone"
mkdir -p weights && curl -sL -o weights/yolox_nano.pth https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.pth || fail "yolox weights"
fi
log "data ready: $(du -sh det anpr | tr '\n' ' ')"
# logs to the shared folder every minute while training
(while true; do cp -f $A/*.log $O/ 2>/dev/null; { date +%H:%M; free -g | sed -n 2p; df -h / | tail -1; } >> $O/resources.log; sleep 60; done) &
timeout 6h bash scripts/${JOB:-night6}.sh || log "${JOB:-night6} ended with an error or after 6 h"
cp -f $A/*.log $O/
cp -f runs/finder/finder_best.pt runs/corners1/corners_best.pt $O/ 2>/dev/null; cp -f runs/corners2/corners_best.pt $O/corners2_best.pt 2>/dev/null
cp -f anpr/reader_v5.keras $O/ 2>/dev/null
grep -q "ALL DONE" $A/night.log && touch $O/DONE || touch $O/FAILED
log "finished; files in out: $(ls $O | tr '\n' ' ')"
# safety: if nobody deletes the pod within 3 hours, stop it
sleep 10800; command -v runpodctl && runpodctl stop pod $RUNPOD_POD_ID
