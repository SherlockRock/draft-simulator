# FM weights card — fm-2026-09-01-6880daa

patches 16.15, 16.16 · train rows 300,885

## Recipe (baselines.fm_arm, main split, no masks)

```
    FM lr=3e-04   wd=1e-02  val-A 0.68743  (best epoch 14/15, 23s)
    FM lr=3e-04   wd=1e-01  val-A 0.68744  (best epoch 14/15, 14s)
    FM lr=1e-03   wd=1e-02  val-A 0.68683  (best epoch 4/15, 16s)
    FM lr=1e-03   wd=1e-01  val-A 0.68682  (best epoch 5/15, 15s)
    FM lr=3e-03   wd=1e-02  val-A 0.68704  (best epoch 2/15, 17s)
    FM lr=3e-03   wd=1e-01  val-A 0.68702  (best epoch 2/15, 15s)
  antisymmetric FM           lr=1e-03 wd=1e-01 val-A 0.68682  test 0.68595  (9,278 params, best epoch 5/15)
```
| seed | lr | wd | best epoch | val-A ll | test ll |
|---|---|---|---|---|---|
| 0 | 0.001 | 0.1 | 5 | 0.68682 | 0.68595 |
| 1 | 0.001 | 0.1 | 5 | 0.68652 | 0.68605 |
| 2 | 0.001 | 0.1 | 5 | 0.68688 | 0.68605 |

3-seed test log-loss spread (retrain noise floor, log-loss units): 0.00010

## Scale

scale = 0.752159 = legacy mean within-set sd 0.06029 / FM 0.08015 over 34,159 identical sibling sets. Per seed: ['0.7522', '0.7483', '0.7353'].

Opus round-1 probe: legacy compStrength sd grows 0.014→0.074 empty→full while FM contribution sd grows 0.027→0.095; global scale is v1, per-fill scale is a follow-up if the A/B shows early-draft imbalance (design §3).

## Contribution (scale × marginal) quantiles over sibling candidates

p0.1 -0.2621 · p50 +0.0073 · p99.9 +0.2321 · outside clamp 0.0000%

## Shipped-rule sibling MRR per seed

['0.3008', '0.3020', '0.3020'] · spread 0.00119 (the retrain gate's spread term)

## Serve-role tax (population linear_expected vs unattainable truth slots, full test drafts)

Δ log-loss +0.00096 CI [+0.00065, +0.00128] MDE 0.00032 B_BETTER (coverage asserted, fail-on-missing)

## Drift vs baseline_fm.pt (the measured checkpoint)

max |Δ weight| = 0.0

## Notes

- A champion missing from the table scores clamp(win_rate): sd ~0.014 vs FM ~5x wider at full states, so it is structurally mid-pack until the retrain (design §3).
- Spearman ρ vs previous weights: n/a (first ship).
