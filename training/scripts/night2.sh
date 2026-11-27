A=/tmp/claude-0/-home-user/72915f6d-0a4c-50cf-ba97-5b1824b4552c/scratchpad/anpr; cd $A; PY="./venv/bin/python -I"
log() { echo "$(date +%H:%M) $*" >> night.log; }
filt() { grep -E "exact|onnx size|RESULT|FINAL|Error|Traceback" ; }
log "resumed round 4 after restart (from epoch 7 best)"
cp train_v4.log train_v4a.log
RESUME=$A/reader_v4.keras OUT=reader_v4.keras PEAK_LR=2e-4 $PY scripts/train.py $A 30 > train_v4.log 2>&1
grep FINAL train_v4.log >> night.log
MODEL=reader_v4.keras ONNX=reader_v4.onnx $PY scripts/export_eval.py $A 2>&1 | filt >> night.log
log "ROUND 4 DONE"
