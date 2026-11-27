# Plate reader training (PARKER)

Moved here from a session scratchpad so new sessions can continue.

## Models
- `models/reader_v4.keras` / `.onnx`: the reader in the app since 3.9 (fp16 copy in `android/app/src/main/assets/models/plate_reader_in.onnx`).
  Unseen test (163 plates): 90.8% exact; at 80% sure: used on 87%, right 141/142. Val 92.6%.
- Plate finder (app 3.12+): `android/app/src/main/assets/models/plate_finder_224.onnx` = `models/finder_yolox224.onnx` (YOLOX-nano 224, Apache-2.0). Old: YOLOv9-t 256 (open-image-models, MIT; in git history).
- 4-corner model (app 3.12+): `plate_corners.onnx` = `models/corners_v1.onnx` (MobileNetV3-small, 160 x 80 grown box -> 4 corners).
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

## Real plate images (in the repo)
`training/data/plates.tgz.part*` = all 10,186 real labelled crops (train/val/test/extra/self/npds/iurs), resized to 256×128 JPEG, with their csv files (paths point to the .jpg). Synthetic plates are not included: run `synth.py`.
```bash
cat training/data/plates.tgz.part* | tar xzf - -C <anpr>/ocrdata
```

## No-licence data (owner's decision, 27 Nov 2026 — kept separate so it can be removed)
`training/data/nolicence_plates.tgz` → `hrlr.csv` (3,606 crops, 448 numbers, many strongly tilted/side-angle; HF adityamangal98/HR-LR-images-of-the-Indian-License-plates, labelled by reader v4 ≥95% after trying straightened/mirrored) and `hfgam.csv` (20; HF Gamester03/indian-number-plate). `train.py` now also loads these when present.
```bash
tar xzf training/data/nolicence_plates.tgz -C <anpr>/ocrdata
```

## Kaggle "Indian License Plate Images" (umar1103/final-licence, CC BY 4.0)
30,451 files; label = file name. Half are CAPTCHA-style or invalid → dropped. Kept 15,987 with valid Indian numbers (mostly rendered/synthetic plates: yellow, green, two-line, blurred). `kaggle.csv`, loaded by `train.py` when present.
```bash
cat training/data/kaggle.tgz.part* | tar xzf - -C <anpr>/ocrdata
```


## Night of 27 Nov 2026 (RTX 4090, Runpod) — results
Scripts: `det_prep.py` (photos with boxes/corners), `yolox_train.py` + `finder_eval.py`, `corner_train.py` + `corner_export.py`,
`train.py` (new: `STRAIGHT`, `CORNER_ERR`, `SELECT=mix`), `pipeline_eval.py` (whole chain), `night6.sh` + `pod_boot.sh` (pod job, no SSH).

| | old | new |
|---|---|---|
| Finder, 163 test plates: found / tight box (IoU>=0.7) | 95.7% / 79.3% | **98.8% / 95.7%** |
| Finder, all 1,207 test photos: found | 83.2% | **95.5%** |
| Finder CPU time, 1 thread | 15.5 ms | **6.0 ms** |
| Whole chain, 154 test plates on photos, straight: exact | 72.7% | **81.8%** |
| Whole chain, turned 20-50 deg: exact | 60.4% | **76.0%** |
| Whole chain, wrong when 95%+ sure (straight / turned) | 1 / 1 | 2 / 2 |
| Same, only the 77 test plates whose number is not in train.csv: exact straight / turned | 72.7% / 67.5% | **77.9% / 75.3%** |

Corner model: mean corner error on hand-labelled real plates 2.2% of plate width (2.4% turned 20-50 deg); the plain box is 7.1% / 10.1%.
Stage 2 (pseudo-corners) was not kept: more sure-but-wrong readings in the chain.

Reader: v4 stays. Three retrains on corner-straightened crops did not beat it (val: plain / straightened / turned+straightened,
v4 = 0.920 / 0.876 / 0.890): round 1 (HR-LR, plain selection) best plain 0.916; round 2 (+ Kaggle, stopped at epoch 10) mixed 0.869;
round 3 (no Kaggle, mixed selection) mixed 0.889. Logs in `logs/`. The Kaggle set made the reader worse on real photos.

Note: 86 of the 163 test plates (and 322 of 500 val) have a number that is also in train.csv (same vehicle, another video
frame), so test numbers flatter the reader; `UNSEEN_ONLY=labels/train.csv pipeline_eval.py` gives the 77 others.
