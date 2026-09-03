# Paired evaluator-vs-candidates measurement

The comparison Phase 2 never ran: production evaluator against the
ship candidates on IDENTICAL rows, both regimes it can score.

## Arm 1 — paired sibling ranking (evaluable intersection, n = 34,159 identical candidate sets; logreg C = 0.03)

| scorer | MRR | top-1 |
|---|---|---|
| evaluator | 0.2967 | 0.1025 |
| fm | 0.3022 | 0.1073 |
| popularity | 0.3390 | 0.1431 |
| logreg_antisym | 0.2952 | 0.0997 |

| comparison (MRR, + = candidate better) | Δ | 95% CI | MDE | verdict |
|---|---|---|---|---|
| fm − evaluator | +0.00550 | [+0.00151, +0.00990] | 0.00420 | **CANDIDATE_BETTER** |
| logreg_antisym − evaluator | -0.00157 | [-0.00562, +0.00289] | 0.00418 | **UNDERPOWERED** |
| popularity − evaluator | +0.04221 | [+0.03821, +0.04618] | 0.00417 | **CANDIDATE_BETTER** |

Spearman ρ vs the evaluator within candidate set (drop-in ≈ 0.9, behaviour change ≈ 0):

- fm: -0.136
- logreg_antisym: -0.157
- popularity: +0.072

## Arm 2 — full-draft log-loss (joined rows n = 34,159; evaluator calibrated by 5-fold cross-fitted Platt)

evaluator (calibrated): log-loss 0.69202, AUC 0.5135

| comparison (log-loss, lower better) | Δ (cand − evaluator) | 95% CI | MDE | verdict |
|---|---|---|---|---|
| fm − evaluator | -0.00603 | [-0.00721, -0.00474] | 0.00125 | **A_BETTER** |
| logreg_antisym − evaluator | -0.00568 | [-0.00689, -0.00461] | 0.00116 | **A_BETTER** |
