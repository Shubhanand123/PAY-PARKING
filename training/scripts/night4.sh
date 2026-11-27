A=/tmp/claude-0/-home-user/72915f6d-0a4c-50cf-ba97-5b1824b4552c/scratchpad/anpr; cd $A; PY="./venv/bin/python -I"
log() { echo "$(date +%H:%M) $*" >> night.log; }
log "round 5 resumed after restart again (epoch 14 of 30, best 0.908)"
RESUME=$A/reader_v5.keras OUT=reader_v5.keras PEAK_LR=1.5e-4 $PY scripts/train.py $A 16 > train_v5.log 2>&1
grep FINAL train_v5.log >> night.log
MODEL=reader_v5.keras ONNX=reader_v5.onnx $PY scripts/export_eval.py $A 2>&1 | grep -E "exact|onnx size|Error|Traceback" >> night.log
log "ROUND 5 DONE"
