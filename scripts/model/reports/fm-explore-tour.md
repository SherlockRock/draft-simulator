# FM explorer tour — `fm-2026-09-01-6880daa`

A guided read of one champion's weights and of how one concrete draft state turns into
per-candidate scores, computed live with `fm_serve.py` through `fm_explore.py`
(exploration tooling, 2026-09-02) and cross-checked against the Rust path in the prebuilt
`index.node`. Every number below reproduces from the commands in the last section.

## 1. What the artifact holds

`data/compiled/fm-weights.json` — version `fm-2026-09-01-6880daa`, rank 16, 173 champions,
`scale 0.752159`, `clamp [0, 1]`, trained on patches 16.15 + 16.16 (300,885 train rows, seed 0,
lr 1e-3, wd 0.1, best epoch 5, test log-loss 0.68595). Per champion, four things:

| field | shape | served? | meaning |
|---|---|---|---|
| `linear_expected` | scalar | yes | Σ_r p(r\|c)·w[c][r] — the champion's standalone value, role-averaged at export |
| `linear` | 5 (TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY) | no (provenance) | the per-role linear weights the model actually learned |
| `synergy` | 16 | yes | within-team vector: ⟨s_c, s_m⟩ is the pairwise synergy with teammate m |
| `counter_a`, `counter_b` | 16 each | yes | cross-team vectors: ⟨a_c, b_o⟩ − ⟨b_c, a_o⟩ is how much c counters opponent o (antisymmetric by construction) |

Nothing else is served: `region_bias` was dropped at export (constant across candidates, cannot
affect a ranking), and there is no role, patch or side input at serve time.

## 2. One champion — Morgana

```
$ .venv/bin/python fm_explore.py --champion Morgana
== Morgana ==  champion-meta positions ['UTILITY']  winRate 0.4962
linear by role   TOP=-0.0310  JUNGLE=+0.0107  MIDDLE=-0.0179  BOTTOM=+0.0165  UTILITY=+0.0016
role prior p(r|c) TOP=0.030  JUNGLE=0.106  MIDDLE=0.102  BOTTOM=0.021  UTILITY=0.742
linear_expected  -0.00011  (recomputed Σ p·w = -0.00011)
‖synergy‖ 0.1423  ‖counter_a‖ 0.2122  ‖counter_b‖ 0.2097  ⟨s,s⟩ 0.0202
best synergy partners    Quinn +0.0262  Syndra +0.0251  Udyr +0.0242  Rell +0.0234  Qiyana +0.0214
worst synergy partners   MissFortune -0.0270  Shaco -0.0256  Jinx -0.0251  Lux -0.0246  Tristana -0.0243
counters best (c vs o)   Varus +0.0585  Chogath +0.0534  Vi +0.0482  Annie +0.0466  Malzahar +0.0426
countered by             Nidalee -0.0594  Graves -0.0522  Fiora -0.0520  Kindred -0.0508  Lux -0.0471
```

What to read off this:

- **The role rule in one line.** The model learned five linear weights for Morgana; the shipped scalar is
  their average under her train-split play rates (74% support, ~10% jungle, ~10% mid). Support's own
  weight is +0.0016; the mid weight is −0.0179 and the jungle weight +0.0107 — they cancel to
  −0.00011. Had the primary-role weight been served instead (the `primary_role` rule the design
  rejected), Morgana would carry +0.0016. Across the table the mean |w_primary − linear_expected| is
  0.0119 against a within-champion role spread of 0.0333, which is the size of what the population
  rule averages away — and the measured cost of doing so is +0.00096 log-loss on full drafts (card).
- **The pairwise vectors are small and dense.** Norms of 0.14–0.21 per vector give pairwise
  dot products of a few hundredths; a full team of four teammates and five opponents therefore
  contributes ±0.03–0.10 to the marginal, i.e. the interaction terms are the same order as
  `linear_expected` and dominate it late in the draft (section 5 quantifies this).
- **Self-synergy is real and must be subtracted.** ⟨s, s⟩ = 0.0202 is what every leaf evaluation
  would spuriously gain without the self-exclusion `S_team − s_c` (the round-1 bug).
- **Sanity of the learned relations.** Morgana counters Varus/Chogath/Vi (black-shield targets, long
  root windows) and is countered by Nidalee/Graves/Fiora (mobile, spell-shield-agnostic). Her worst
  synergy partners are hyper-carry marksmen (Miss Fortune, Jinx, Tristana) — the model has learned
  a "Morgana does not enable a farm-to-late-game bot lane" relation. These are 2-patch, 300k-game
  estimates: treat them as plausible, not as truth.

## 3. A concrete state — red's last pick, holdout game `EUW1_7957728380`

Blue: Gragas, Hecarim, Akali, Xayah, Shen. Red so far: Sejuani, Sylas, Lissandra, Tristana. Red picks
last (turn 19). The candidate set is the holdout sibling set for this slot (true pick first: Morgana).
Both teams are role-feasible under champion-meta positions, which is why this game was chosen — see
section 6.

```
$ .venv/bin/python fm_explore.py --blue Gragas,Hecarim,Akali,Xayah,Shen --red Sejuani,Sylas,Lissandra,Tristana \
    --candidates Morgana,Pyke,Leona,Camille,Maokai,Janna,Rell,Thresh,Braum,Milio --explain Morgana
state  team(red) = Sejuani, Sylas, Lissandra, Tristana   opp = Gragas, Hecarim, Akali, Xayah, Shen   action = pick   scale = 0.752159
  # champion        lin_exp  synergy  counter  marginal    alloc  compFM  legacy  lg#   Δ#
  1 Braum           +0.0198  +0.0857  +0.0245   +0.1300  +0.0749  0.5978  0.4146    6   +5
  2 Thresh          +0.0494  -0.0138  +0.0306   +0.0662  +0.0578  0.5498  0.4777    2   +0
  3 Janna           +0.0320  +0.0090  +0.0073   +0.0482  +0.0401  0.5363  0.3519    9   +6
  4 Morgana         -0.0001  -0.0385  +0.0434   +0.0048  +0.0023  0.5036  0.4091    7   +3
  5 Pyke            +0.0315  +0.0280  -0.0627   -0.0033  +0.0141  0.4975  0.3856    8   +3
  6 Maokai          +0.0120  -0.0034  -0.0140   -0.0053  +0.0034  0.4960  0.3341   10   +4
  7 Leona           +0.0411  -0.0218  -0.0246   -0.0054  +0.0178  0.4960  0.5049    1   -6
  8 Milio           -0.0065  -0.0027  -0.0136   -0.0229  -0.0147  0.4828  0.4662    3   -5
  9 Rell            +0.0364  -0.0938  +0.0015   -0.0559  -0.0097  0.4580  0.4532    4   -5
 10 Camille         -0.0048  -0.0588  -0.0510   -0.1146  -0.0597  0.4138  0.4266    5   -5
```

Columns: `lin_exp + synergy + counter = marginal`; `alloc = lin_exp + ½·synergy + ½·counter` (the
share this champion would hold in a leaf sum once picked); `compFM = clamp(0.5 + scale × marginal)`;
`legacy` is the pre-FM `compStrength` (`clamp(winRate − Σ max(−counter, 0))`, synergy stub = 0);
`lg#` its rank and `Δ#` = legacy rank − FM rank.

Morgana term by term:

```
== Morgana ==
linear_expected            -0.00011
  synergy ⟨s_c, s_Sejuani⟩ -0.00067
  synergy ⟨s_c, s_Sylas⟩ -0.00854
  synergy ⟨s_c, s_Lissandra⟩ -0.00499
  synergy ⟨s_c, s_Tristana⟩ -0.02430
synergy   Σ                -0.03849
  counter ⟨a_c,b_Gragas⟩−⟨b_c,a_Gragas⟩ -0.01982
  counter ⟨a_c,b_Hecarim⟩−⟨b_c,a_Hecarim⟩ +0.01259
  counter ⟨a_c,b_Akali⟩−⟨b_c,a_Akali⟩ -0.00091
  counter ⟨a_c,b_Xayah⟩−⟨b_c,a_Xayah⟩ +0.04101
  counter ⟨a_c,b_Shen⟩−⟨b_c,a_Shen⟩ +0.01054
counter   Σ                +0.04341
marginal  = lin+syn+ctr    +0.00480   → compStrength = clamp(0.5 + 0.752159×marginal) = 0.50361
allocation = lin+½syn+½ctr +0.00235   (this champion's leaf share once it is on the team)
legacy    winRate 0.4962  − risk[Gragas]=0.0871  − risk[Hecarim]=0.0000  − risk[Akali]=0.0000  − risk[Xayah]=—  − risk[Shen]=0.0000  → 0.4091
```

Reading the state:

- **Braum is the FM's pick and it is a synergy call**: +0.0857 from the four teammates (Sejuani /
  Sylas / Lissandra engage plus Tristana), nearly three times its linear term. Legacy has no synergy
  at all (stub), so it puts Braum 6th on win rate minus counter risk.
- **Leona is legacy's #1 and the FM's #7.** Legacy sees a 0.5049 win rate and no counter risk; the
  FM sees a good standalone value (+0.0411, the second-best linear in the set) cancelled by mild
  negative synergy and counters. This is the Spearman ρ ≈ −0.14 behaviour change made concrete.
- **Morgana (the actual pick) is 4th of 10 for the FM, 7th for legacy.** The FM's reason is a counter
  reason: +0.041 against Xayah, −0.020 against Gragas, net +0.043, against a synergy penalty for
  playing with Tristana (−0.024).
- **Rell shows the two terms disagreeing hardest**: a strong linear (+0.036) against a −0.094
  synergy sum. Legacy, which cannot see the synergy, rates her mid-pack.
- **Legacy's counter risk is one-sided and sparse**: only Gragas registers for Morgana (−0.0871);
  Xayah has no entry at all ("—"). The FM's counter term is dense, signed both ways and
  antisymmetric.
- **The spread is what `scale` was fitted to.** Within this set the FM marginals span 0.24
  (Camille −0.115 to Braum +0.130), compFM spans 0.18; legacy spans 0.17 (0.334–0.505). Nothing is
  near the clamp (the A/B counted 0 clamps in 14.3 M scored candidates).

## 4. How the number reaches the Navigator

- `score_pick` calls `comp_strength_for(candidate)`; the FM branch computes `marginal` (the
  candidate is never on either team — the search filters used champions) and maps it to
  `compStrength = clamp(0.5 + 0.752159 × marginal)`. That value is blended with the phase weights —
  at red pick2 `comp 0.8 / info 0.2 / coverage 1.5` — and multiplied by the pool tier factor. So the
  ordering the Navigator uses to choose which five candidates to expand is *not* the compFM column
  alone; coverage (1.5 × marginal role-coverage gain) can outrank it at a missing-role turn.
- Once a champion is **on** a team it is scored by `allocation` (pairwise terms halved) in
  `side_total`, so that Σ blue allocations − Σ red allocations equals the model's structural logit
  exactly. The same champion therefore has two different numbers: as a candidate (marginal) and as a
  teammate in a leaf (allocation, e.g. Morgana +0.0048 vs +0.0023). They are each correct for their
  purpose and not comparable to each other.
- **Children are ordered by the backed-up leaf value, not by `marginal`.** At depth ≥ 1 a child's
  `composite` is its subtree's leaf evaluation, so the displayed order is Σ allocation of the resulting
  team (plus coverage and info), which weights the candidate's counter term at ½. `marginal` only
  decides which candidates get expanded at all (`branchWidth 5`).

## 5. The state through the draft — what carries the signal at each fill level

Mean within-set standard deviation of `marginal` and of its three terms over 4,000 holdout sibling
sets with team/opp randomly masked to the given sizes (the shipped weights; `scripts` in section 7):

| fill (team, opp) | sd marginal | sd lin | sd synergy | sd counter | sd × scale | mean \|marginal\| |
|---|---|---|---|---|---|---|
| (0,0) | 0.0157 | 0.0157 | 0 | 0 | 0.0118 | 0.0155 |
| (1,1) | 0.0361 | 0.0157 | 0.0165 | 0.0239 | 0.0271 | 0.0334 |
| (2,2) | 0.0504 | 0.0157 | 0.0235 | 0.0355 | 0.0379 | 0.0466 |
| (3,3) | 0.0617 | 0.0157 | 0.0291 | 0.0445 | 0.0464 | 0.0569 |
| (4,4) | 0.0728 | 0.0157 | 0.0338 | 0.0536 | 0.0548 | 0.0673 |
| (4,5) | 0.0805 | 0.0157 | 0.0338 | 0.0617 | 0.0605 | 0.0744 |

At an empty board the FM is exactly a 173-entry champion prior (`linear_expected`; sd 0.0157,
correlation +0.29 with the u.gg win rate the legacy path uses, so it is *not* the same prior). By
the last pick the counter term alone has 4× that spread and synergy 2×. The card's 0.027→0.095
growth (Opus's probe) is the same phenomenon measured on a different sample; the global `scale`
is fitted at the near-full end (34,159 identical full sets) and so under-spreads early picks
relative to legacy — the "per-fill scale" lever in the levers map.

## 6. Cross-check against the Rust path

Two independent checks, both exact to floating-point rounding.

**(a) The committed parity fixtures.** `cargo test -p engine-core --test fm_parity` runs
`search_with_stats(max_depth 0)` → `eval_state` → `side_total` on 50 fixtures under a flat context
(comp 1 / info 0 / coverage 0, no pool penalty), inverts `0.5 + scale ×` on each side's composite and
asserts the allocation sums against `fm-parity.json` (tolerance 1e-6; passes, 0.01 s). Fixture 0
recomputed with `fm_serve` on the shipped weights:

```
fixture 0: Jax, Graves, Diana, Tristana, Blitzcrank  vs  Malphite, Zed, Syndra, Kaisa, Qiyana
  json blue 0.024735929 py 0.024735929 | json red 0.085184125 py 0.085184125 | logit -0.060448196 (both)
```

**(b) The live check through `index.node` (`--engine`).** `fm_explore.py` builds a real protocol
request for the state (flat weights, zero penalties, full-roster pools, `maxDepth 1`, bans padded so
the turn index lands on the side's pick), runs it through `fm_engine_probe.cjs` — the same
`packages/engine-node/index.node` the backend loads — once with `ourSide: blue` and once with
`ourSide: red` (the wire tree only carries the requesting side's composite), inverts each child's
composite into that side's allocation sum, and compares with `fm_serve`:

```
[fm_engine_probe] fm: loaded version=fm-2026-09-01-6880daa patches=16.15,16.16 champions=173
root structural logit (python) -0.006915   children compared: 29
child                   eng blueΣ   py blueΣ   eng redΣ    py redΣ       |Δ|    moverΔ  marginal
Braum                   +0.141230  +0.141230  +0.278163  +0.278163  4.44e-16  +0.13002  +0.13002
Janna                   +0.149870  +0.149870  +0.205033  +0.205033  2.22e-16  +0.04825  +0.04825
Leona                   +0.165792  +0.165792  +0.167341  +0.167341  5.55e-16  -0.00537  -0.00537
Pyke                    +0.184850  +0.184850  +0.188496  +0.188496  3.33e-16  -0.00327  -0.00327
…
max |engine − python| over allocation sums: 7.22e-16
```

`moverΔ` is the engine's logit(S + c) − logit(S) from red's side and equals `marginal(c)` for
every child, which is the design §2 identity (allocation sums difference to the logit; the marginal
is the exact logit change) observed end-to-end through the real binary. The same check on the empty
board (36 children, all `marginal = linear_expected`, max |Δ| 7.6e-17) and on a blue pair turn
(25 pair children, max |Δ| 3.6e-16) passes as well. It is also a pytest
(`test_fm_explore.py::test_engine_allocation_sums_match_fm_serve_on_a_real_state`, skips without
`index.node`).

Two things the live check exposes that the fixtures cannot: the engine expanded 29–43 children per
request from the full roster (the wire keeps the top 32 per requesting side plus scenario paths, so
the two requests overlap on 29); and a real state has to be role-feasible under champion-meta
positions for any child to exist at all — of the 34,159 evaluable holdout sets only 12,153 (35.6%)
have both the real opposing five and the real team-plus-true-pick feasible under those stale
positions (Sylas, Viktor, Qiyana, Syndra, Nasus, Naafiri, Jayce, Yone, Zaahen (no positions at all),
Ambessa, Corki, Zed are the champions whose removal most often restores feasibility). That is the
pre-existing "empty tree" gotcha, and it is not a ban-turn oddity: it is the majority case late in a
real draft.

## 7. Reproduce

```
cd scripts/model && P=.venv/bin/python
$P fm_explore.py --champion Morgana
$P fm_explore.py --blue Gragas,Hecarim,Akali,Xayah,Shen --red Sejuani,Sylas,Lissandra,Tristana \
   --candidates Morgana,Pyke,Leona,Camille,Maokai,Janna,Rell,Thresh,Braum,Milio --explain Morgana --engine
$P fm_explore.py --engine --top 5                      # empty board, blue first pick
$P fm_explore.py --blue Gragas --red Sejuani,Sylas --engine --top 3   # blue pair turn
$P fm_explore.py --blue A,B --red C,D --json           # machine-readable rows
cargo test -p engine-core --test fm_parity             # the committed fixtures
$P -m pytest -q                                        # 125 tests incl. the live engine parity
```

The fill-level table in section 5 and the feasibility counts in section 6 come from
`fm_explore_scan.py` (random masking, seed 1, 4,000 sets, over
`data/training/{sibling_sets.csv,holdout_drafts.csv}`); it also recomputes the card's sibling MRR
(0.3008, matches) and prints the region biases the export drops
(euw1 −0.105, kr −0.029, na1 −0.062 on the blue-win logit).
