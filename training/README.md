# Plate reader training (PARKER)

Moved here from a session scratchpad so new sessions can continue.

## Models
- `models/reader_v4.keras` / `.onnx`: the reader in the app since 3.9 (fp16 copy in `android/app/src/main/assets/models/plate_reader_in.onnx`).
  Unseen test (163 plates): 90.8% exact; at 80% sure: used on 87%, right 141/142. Val 92.6%.
- Plate finder: `android/app/src/main/assets/models/plate_finder_256.onnx` (YOLOv9-t 256, MIT, open-image-models).
- Base model for training from scratch: fast-plate-ocr `cct_xs_v2_global` (MIT), downloaded by `prep.py`.

## Data (all business-safe licences) — rebuild images with the scripts, labels are in `labels/`
| csv | images | source / how |
|---|---|---|
| train/val/test.csv | 2,505 / 500 / 163 | `prep.py` (public Indian plate OCR sets, see script) — val/test numbers are never used for training |
| synth.csv | 16,765 | `synth.py` synthetic plates |
| extra.csv | 386 | `chars2text.py` from Roboflow char-box sets (lynkit, indian-plate-chars) |
| self.csv | 1,466 | `selflabel.py` on 4 Roboflow plate-box sets, reader ≥95% sure + valid |
| npds.csv | 4,206 | `npds_read.py` on Mendeley NPDS sxrnr7hwtk (CC BY 4.0) |
| iurs.csv | 960 | `iurs_crops.py` + `fix_orient.py` on Mendeley IURS znghtgfnnf (CC BY 4.0, char boxes) |
Tried and not useful: Roboflow "Vehicle Detection Indian v1" (plates too small), "Indian License Plate" (nivu, duplicates). ILPD (arXiv 2111.06054) is not public.

## Results so far
- v4 = best. Round 5 (strong side-angle augmentation) and round 6 (+IURS) never beat v4 on val.
- `train.py` saves full state every epoch (`*.last.keras` + json) and resumes after a container restart; a resumed run only saves a model that beats its start.
- Side angles are handled in the app by `PlateStraightener.java` (3.10+); `straight_test.py` and `timing_sim.py` test it.

## Next (GPU, Runpod)
1. Faster plate finder at 224 px (YOLOX, Apache-2.0 — not ultralytics/YOLOv9 repo, licence).
2. 4-corner plate model for proper side-angle straightening.
3. Retrain the reader on straightened crops; later on the gate's own saved scans (Supabase table `parking_scans`, bucket `scans`).
