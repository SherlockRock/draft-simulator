# Serving-distribution FM — training + paired measurement

## Serving-distribution FM sweep (masked val-A selects)

  lr=3e-04   wd=1e-02  masked val-A 0.68949 (epoch 14/15)
  lr=3e-04   wd=1e-01  masked val-A 0.68950 (epoch 14/15)
  lr=1e-03   wd=1e-02  masked val-A 0.68951 (epoch 4/15)
  lr=1e-03   wd=1e-01  masked val-A 0.68950 (epoch 4/15)
  lr=3e-03   wd=1e-02  masked val-A 0.68968 (epoch 1/15)
  lr=3e-03   wd=1e-01  masked val-A 0.68969 (epoch 1/15)

selected lr=3e-04 wd=1e-02; 3 seeds:
  seed 0: masked val-A 0.68949
  seed 1: masked val-A 0.68947
  seed 2: masked val-A 0.68949

## Arm 1 — paired sibling MRR vs evaluator (n = 34,159)

| seed | serve-FM MRR | Δ vs evaluator | 95% CI | MDE | verdict |
|---|---|---|---|---|---|
| 0 | 0.2992 | +0.00247 | [-0.00169, +0.00693] | 0.00425 | **UNDERPOWERED** |
| 1 | 0.2990 | +0.00228 | [-0.00185, +0.00699] | 0.00424 | **UNDERPOWERED** |
| 2 | 0.2977 | +0.00093 | [-0.00327, +0.00530] | 0.00423 | **UNDERPOWERED** |

## Arm 2 — full-draft log-loss (n = 34,159)

| seed | serve-FM ll | vs evaluator | vs logreg_antisym |
|---|---|---|---|
| 0 | 0.68800 | -0.00402 **A_BETTER** | +0.00166 **B_BETTER** |
| 1 | 0.68808 | -0.00393 **A_BETTER** | +0.00175 **B_BETTER** |
| 2 | 0.68813 | -0.00389 **A_BETTER** | +0.00179 **B_BETTER** |

## Fill-bucket coverage (test replicas; one mask per row/bucket)

| bucket | serve-FM | full-draft FM | 4-6 refit FM | constant | serve − best rival (MDE) |
|---|---|---|---|---|---|
| 0-0 | 0.68797 | 0.68595 | 0.68861 | 0.69235 | +0.00202 vs fulldraft_fm (MDE 0.00076) |
| 1-3 | 0.68889 | 0.68790 | 0.68911 | 0.69235 | +0.00098 vs fulldraft_fm (MDE 0.00062) |
| 4-6 | 0.68970 | 0.68874 | 0.68993 | 0.69235 | +0.00096 vs fulldraft_fm (MDE 0.00044) |
| 7-9 | 0.69161 | 0.69144 | 0.69157 | 0.69235 | +0.00017 vs fulldraft_fm (MDE 0.00018) |
