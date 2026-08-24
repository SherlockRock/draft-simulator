# scripts/model — custom draft win-probability model

Own Python environment (uv), deliberately outside the pnpm workspace.

    uv venv .venv && uv pip install -p .venv/bin/python -e .        # or: uv sync
    ../match-pipeline/export-parquet.sh ../../data/training          # Postgres → parquet (~90 s / 155k rows)
    .venv/bin/python explore.py ../../data/training/matches_<date>.parquet

- `explore.py` — Phase 2 corpus exploration (handoff questions 2–8); read-only over the parquet,
  caches the flattened table next to it as `*.flat.parquet`.
- Plan: `docs/plans/2026-08-24-custom-model-phase2-plan.md`. Training code lands per that plan.

## Phase 2 pipeline

| step | script | output |
|---|---|---|
| 0 | `node ../scrape-cdragon.mjs` + `common.py` | fresh aliases, `EVALUABLE` rule |
| 1b-a | `mask_table.py` | `mask_table.json` — leaf fill pattern per (root turn, depth) |

Tests: `.venv/bin/python -m pytest` from this directory.
