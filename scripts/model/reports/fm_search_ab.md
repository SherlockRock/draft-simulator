# FM search A/B — merge-blocking thresholds (design §5)

FM `fm-2026-09-01-6880daa` (scale 0.752159) vs the legacy evaluator, on 48 real holdout draft prefixes,
3 repetitions per state in alternating arm order, production search config.

**Deviations from the plan.** Depth-controlled mode uses `pair_branch_width 25` instead of the plan's 500: a depth-2 search from a pair-start root spans two consecutive pair plies, so 500 makes that tree ~500² leaves (~5 min per call, >1 day for the run). Both arms use the same width, so the node-count ratio is unaffected. Budget-controlled mode is unchanged production config (`branch_width 5`, `pair_branch_width 500`, `max_depth 8`, 5000 ms budget, 60000 ms watchdog).

## Thresholds

| check | value | threshold | result |
| --- | ---: | ---: | --- |
| clamp saturation | 0.0000 | < 0.05 | PASS |
| candidate sets below the cross-seed floor | 0.0000 | < 0.05 | PASS |
| depth-controlled node-count ratio (on/off) | 1.0000 | <= 2.00 | PASS |
| budget-controlled wall-time ratio (on/off) | 1.0307 | <= 1.50 | PASS |

Clamp counter: 0 clamped of 16967386 scored. Cross-seed noise floor: 0.01402.

**Recorded, not gated** — root top-move agreement: 0.2083 (30/144 arm comparisons). Budget-mode watchdog timeouts: 33 off, 35 on (of 144 runs each).

## Per stratum

| stratum | turns | states | node ratio | wall ratio | agreement | mean spread | mean floor | below floor |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | `[0,2,4,6]` | 12 | 1.000 | 0.999 | 0.2500 | 0.01853 | 0.00193 | 0.0000 |
| B | `[7,8,9]` | 12 | 1.000 | 0.944 | 0.0000 | 0.04024 | 0.01131 | 0.0000 |
| C | `[10,11,12,14,16]` | 12 | 1.000 | 1.312 | 0.3333 | 0.06855 | 0.01842 | 0.0000 |
| D | `[17,18,19]` | 12 | 1.000 | 0.895 | 0.2500 | 0.08912 | 0.02442 | 0.0000 |

Every per-state number (nodes, walls, depths, timeouts, per-rep agreement) is in `fm_search_ab.json`.
