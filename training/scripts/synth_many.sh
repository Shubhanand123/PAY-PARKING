#!/bin/bash
# Many synthetic plates in parallel: synth_many.sh OCRDATA TOTAL [BLURRY]  -> OCRDATA/synth2.csv (+ synth/b*.jpg)
# Each worker has its own seed; the original synth.csv set is not touched.
D=$1; N=$2; J=${J:-$(nproc)}; per=$(( (N + J - 1) / J ))
for k in $(seq 1 $J); do SEED=$((1000 + k)) PREFIX=b${k}_ CSV=synth2_$k.csv BLURRY=$3 python -I $(dirname $0)/synth.py $D $per > /dev/null & done; wait
{ echo image_path,plate_text; for k in $(seq 1 $J); do tail -n +2 $D/synth2_$k.csv; rm $D/synth2_$k.csv; done; } > $D/synth2.csv
echo "synthetic plates (set 2): $(( $(wc -l < $D/synth2.csv) - 1 ))"
