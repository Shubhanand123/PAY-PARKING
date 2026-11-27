# Night pipeline: round 3 (running) -> evaluate -> re-read NPDS -> round 4 -> evaluate -> re-read -> round 5 -> evaluate.
A=/tmp/claude-0/-home-user/72915f6d-0a4c-50cf-ba97-5b1824b4552c/scratchpad/anpr; cd $A; PY="./venv/bin/python -I"
log() { echo "$(date +%H:%M) $*" >> night.log; }
filt() { grep -E "exact|onnx size|RESULT|FINAL|Error|Traceback" ; }
log "restarted with motion-blur training (hand shake)"
grep FINAL train_v3.log >> night.log
prev=v3
for r in 4 5; do
  MODEL=reader_$prev.keras ONNX=reader_$prev.onnx $PY scripts/export_eval.py $A 2>&1 | filt >> night.log
  READER=$A/reader_$prev.onnx $PY scripts/npds_read.py $A 2>&1 | filt >> night.log
  log "round $r training"
  RESUME=$A/reader_$prev.keras OUT=reader_v$r.keras PEAK_LR=3e-4 $PY scripts/train.py $A 40 > train_v$r.log 2>&1
  grep FINAL train_v$r.log >> night.log; prev=v$r
done
MODEL=reader_$prev.keras ONNX=reader_$prev.onnx $PY scripts/export_eval.py $A 2>&1 | filt >> night.log
log "ALL DONE"
