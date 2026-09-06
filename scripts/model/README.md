# scripts/model — custom draft win-probability model

Own Python environment (uv), deliberately outside the pnpm workspace.

    uv sync                                                          # creates .venv with the CPU torch wheel
    ../match-pipeline/export-parquet.sh ../../data/training          # Postgres → parquet (~90 s / 155k rows)
    .venv/bin/python explore.py ../../data/training/matches_<date>.parquet

- `explore.py` — Phase 2 corpus exploration (handoff questions 2–8); read-only over the parquet,
  caches the flattened table next to it as `*.flat.parquet`.
- Plan + execution log: `docs/plans/2026-08-24-custom-model-phase2-plan.md` (gitignored).

## Phase 2 pipeline — run in this order

Every artifact lands in `data/training/` (gitignored). `P=.venv/bin/python`.

| step | command | output |
|---|---|---|
| 0 | `node ../scrape-cdragon.mjs` | fresh `data/raw/cdragon-champions.json` (Locke must resolve) |
| 1b-a | `$P mask_table.py` | `mask_table.json` — leaf fill pattern per (root turn, depth) |
| 1b-b | `cargo test -p engine-core --test leaf_eval_stats -- --ignored --nocapture` | `leaf_eval_stats.json` (achieved depths, leaf evals/query) |
| 1a | `$P prepare.py ../../data/training/matches_<date>.parquet` | `dataset.parquet`, vocabs, `role_percentages.json`, `folds.parquet`, `sibling_sets.*`, `masked_states.*`, `holdout_drafts.csv`, `solver_states.csv` |
| 2b | `cd ../../packages/engine-node && cargo test emit_solver_roles -- --ignored --nocapture` | `solver_roles.csv` (argmax + posterior for every val/test state, all folds) |
| 2 | `$P baselines.py --folds --masked` | `baselines.json`, `baseline_preds*.npz`, `baseline_fm*.pt` |
| 5 | `cd ../../packages/engine-node && cargo test evaluator_scores -- --ignored --nocapture` | `evaluator_scores.csv`, `evaluator_sibling_scores.csv`, `evaluator_throughput.json` |
| 3 | `$P train.py --stage arch && $P train.py --stage aug && $P train.py --stage main && $P train.py --stage folds` | `sweep_*.json`, `model_seed{0,1,2}.pt`, `model_fold_preds.npz` |
| 4 | `$P evaluate.py` | `evaluate.json`, `model_test_preds.npy` (arms × seeds × rows), `model_masked_preds.npy` |
| 1 | `$P sibling_scores.py` | `sibling_scores.npz` |
| 6 | `$P benchmark.py` | `benchmark_report.md`, `benchmark.json` — the verdict |
| 7 | `$P export_onnx.py` | `model.onnx`, `onnx_latency.json`, `model_card.md` |

Gates 1–4 run over every `model_seed*.pt` and report mean ± spread across seeds.
`train.py` refuses to select a checkpoint on a val set the solver has not fully covered
(`serve.coverage`), so re-run 2b after any re-run of 1a.

Tests: `.venv/bin/python -m pytest` from this directory (the data-dependent ones skip
until 1a/2b have run). Rust harness unit tests: `cargo test -p engine-node`.

## Phase 3 — the shipped FM evaluator

`ship_fm.py` trains 3 seeds by the baselines recipe and writes `data/compiled/fm-weights.json`
(seed 0, shipped), `data/compiled/fm-parity.json` (Rust parity fixtures), `reports/fm-weights-card.md`,
and `data/training/fm-weights-seed{1,2}.json` (noise floor for the search A/B). Prerequisite: the
Task 5 harness has been re-run so `evaluator_sibling_scores.csv` carries `comp_strength`.

Per-patch retrain: `prepare.py <new parquet>` → **`node ../refresh-champion-positions.mjs && node ../compile-champion-meta.mjs && node ../validate-compiled-data.mjs`** (positions from
`role_percentages.json`, the TRAIN split's play rates at threshold 0.10, ordered by rate — design
`docs/designs/champion-meta-positions-refresh-design.md`; it prints the primary flips and the
both-sides feasibility of the holdout next to the previous run's and aborts a recurring run on a
> 2-point drop or > 10 flips) → re-run the Task 5 harness (it bakes champion-meta's `winRate` into
`comp_strength`, which `ship_fm.py` turns into `scale`, so it must see the meta that will ship) →
`ship_fm.py` → `fm_retrain_gate.py` (blocks the commit on a paired sibling-MRR regression beyond both
the MDE and the card's 3-seed spread) → `cargo test -p engine-core --test fm_parity` → commit weights +
fixtures + card **+ `frontend/src/data/champions.json` + `data/compiled/champion-meta.json`**.
Deploy both services together: the frontend bundles `champions.json` at build time and the backend
loads champion-meta at engine construction. Rollback = revert both JSON files and redeploy; do not
recompile. A champion released after the corpus freeze keeps whatever `champions.json` holds; if
that is `[]` the compile refuses it — hand-enter positions until the next retrain. Saved Navigator
pools are not rewritten: `pool_multiplier` keys by the champion's primary, so a pool built under the
old primaries files some champions out-of-role (×0.75) until the user reloads defaults.
`--source ugg` (per-role match counts in `data/compiled/winrates.json`) is the fallback for a machine
without the corpus and is **unmeasured at parity**: the file on disk is patch 16_8 (the scraper's
`PATCH` is a hard-coded constant) and scored 0.607 both-sides against the corpus's 0.785 — bump the
patch and re-scrape before trusting it. **First post-refresh retrain card:** Locke is evaluable since the
2026-09 refresh, so the sibling sets and holdout of the next `prepare.py` include him; the retrain gate
compares on current sets, so this is fine, but note it on that card (design § 7 risk 6). After any
champion-meta change re-run step 2b (`emit_solver_roles`, ~1 min) or `test_roles.py` compares against a
stale `solver_roles.csv`.

Exploring the shipped weights: `fm_explore.py` scores any blue/red state the way `fm_comp_strength`
does (marginal, allocation, `compStrength`, legacy side by side; `--explain` for the term-by-term
decomposition, `--champion` for one champion's weights, `--engine` to cross-check allocation sums
against the prebuilt `index.node` through `fm_engine_probe.cjs`); `fm_explore_scan.py` prints the
fill-level spread and role-feasibility numbers. Write-ups: `reports/fm-explore-tour.md` (one
champion, one state, the Rust cross-check) and `docs/designs/fm-fine-tuning-levers.md` (local).

Kill switch: `NAVIGATOR_FM=off` on the backend makes the engine boot without the FM (legacy
`compStrength`). The engine is built at module load, so it takes effect on restart; on Railway a
variable change redeploys. Weights rollback = git revert + redeploy.

Release-day line: a champion missing from the table scores `clamp(winRate)` — structurally mid-pack —
until `ship_fm.py` is re-run on a corpus containing them. Expect the Navigator to neither recommend
nor warn about the newest champion until then.
