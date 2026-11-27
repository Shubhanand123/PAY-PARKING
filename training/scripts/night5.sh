A=/tmp/claude-0/-home-user/72915f6d-0a4c-50cf-ba97-5b1824b4552c/scratchpad/anpr; cd $A; PY="./venv/bin/python -I"
log() { echo "$(date +%H:%M) $*" >> night.log; }
[ -f reader_v6.keras ] && R=reader_v6.keras || R=reader_v4.keras
log "round 6 (adds 960 hand-labelled IURS plates, light side-angle practice) from $R"
RESUME=$A/$R OUT=reader_v6.keras PEAK_LR=2e-4 $PY scripts/train.py $A 20 >> train_v6.log 2>&1
grep FINAL train_v6.log | tail -1 >> night.log
MODEL=reader_v6.keras ONNX=reader_v6.onnx $PY scripts/export_eval.py $A 2>&1 | grep -E "exact|onnx size|Error|Traceback" >> night.log
log "ROUND 6 DONE"
