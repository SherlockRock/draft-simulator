# Tier B — real positions

Spec: Obsidian `draft-simulator-engine-target` § 3 (Tier B) and D7; design `docs/designs/engine-live-universe-design.md` § 6 (slice 5) and `docs/designs/engine-b-proper-design.md` § 3 (B-proper: the calibration report).

One JSON per position, hand-authored by the user from their own prep ("I had a real decision here") — later pro positions in a second pass. **No expected outputs**: a Tier B file carries the position, the pools and soft annotations; the engine's answer is read by a human against the rubric, never asserted. The reader is the user until a second reader exists; free-text verdicts go in `review`, one line per reading, so a second reader is additive; the one structured verdict, `verdict.off_pool`, is what calibrates P (below).

The loader (`engine_core::reference::tier_b`) validates a file against the **current** live universe (`fm-weights.json` + `champion-meta.json`). Ids are strict here (a typo in a hand-authored file fails loudly). A `source` version that differs from the loaded data is a warning, not an error — a Tier B position is meant to be re-read against current data; an `actual_next` the reference could not generate (already on the board, or excluded) is a warning too, and a `verdict` on a ban root is a warning (there is no off-pool question at a ban). One malformed file is reported in its place; the rest of the directory still loads and runs.

## Run the report

```
cargo test --release -p engine-core --test tier_b -- --ignored --nocapture tier_b_report
```

It is `#[ignore]` by design: a report, never a gate, and an empty directory must never be green. Environment:

| variable | default | meaning |
|---|---|---|
| `TIER_B_P` | `0.05,0.15,0.25` | the P values (blue-win logits) the `roster` arm sweeps; `0.15` is `DEFAULT_OFF_POOL_COST` |
| `TIER_B_WIDTHS` | `30,60,100` | the shortlist as `singles,pairs,root_off_pool` (B-proper § 2); every arm runs at the same widths |
| `TIER_B_HORIZON` | `2` | turns searched below the root (a pair is one) |

Every position runs under two rules: **`pool_or_roster`** (slice-5 U10: a side picks from its pool while the pool can still complete its comp and from the whole roster once it cannot, each off-pool pick costing a flat P = L — lexicographic, the engine never leaves a pool that can finish) and **`roster`** at each P of the sweep (B-proper: the pool prices and never gates; every pick node fans to the roster; an off-pool pick costs P on the board's scale, so a strong roster champion can be worth its cost). Under both, a side that cannot finish even from the roster pays the wider L' = L + 10·L, so breaking one's own comp alone is never worth an off-pool pick saved (a line that breaks BOTH sides is R1's board plus the netted off-pool term — the S11 residual); a position where a side's LOCKED picks already cannot fill five roles is still ranked, that side in the L' band on every line; the gate would refuse it. A Tier A fixture may declare neither live rule.

The search is shortlisted (B-proper § 2): at an interior pick node the best `singles` / `pairs` children by the static ordering survive (feasible first, the best failures fill); at a pick root every in-pool action is ranked plus the best `root_off_pool` off-pool ones. Truncation is not exact, and each block says "searched k of N".

## Fields

| field | type | rule |
|---|---|---|
| `id` | string | file name without `.json`; date-prefixed (`2026-10-03-red-pick-slot-11-vs-t1`) — a convention, not checked by the loader |
| `category` | `pro-replay` \| `counter-pick` \| `flex-retention` \| `pair-coherence` \| `edge-case` \| `off-pool` | D7's tags, plus `off-pool`: a position where an off-pool pick tempts — the calibration subset |
| `notes` | string | why this was a real decision |
| `source` | `{ fm_version, meta_version, captured, session? }` | the data the position was captured on; `session` is the Navigator session id when there is one |
| `format` | `"standard"` | the only format this slice loads |
| `position` | `[{ slot, side, kind, champion? }]` | slot = index; `side` is `Blue`/`Red`; `kind` is `ban`, `pick` or `skip`; a `skip` (a forfeited ban) is legal on ban slots only and names no champion |
| `pools` | `{ blue: [id], red: [id] }`, optional | each side's search pool as a set; a side's own picks already on the board are added automatically (a past off-pool pick is a fact, not a choice). **Absent = the whole roster on both sides** (a pro replay, D7: "no pools") |
| `exclusions` | `[id]`, default `[]` | cross-game exclusions (fearless): unavailable to both sides — never a ban, never a pick |
| `our_side` | `Blue` \| `Red`, optional | the side the rubric is read from |
| `actual_next` | id, `[a, b]` at a pair start, or absent | what was actually played next — the soft comparison point, never truth; the report says whether it was in the pool |
| `review` | string, default `""` | rubric verdicts in prose, appended per reading |
| `verdict` | `{ "off_pool": true \| false }`, optional | **would you leave the pool here** — the one structured verdict, read by the calibration summary (below); meaningful at a pick root only |
| `capture` | object with a string `protocolVersion`, optional | the raw captured request (the wire `EngineRequest` once the capture button exists), kept opaque so nothing the loader does not model (display pools, tiers) is lost. **Provenance only: the top-level `pools` / `exclusions` are the position**; when the capture's search pools or `crossGameExclusions` differ from them the loader warns and uses the top-level fields |

Unknown fields are rejected (`deny_unknown_fields`), inside `verdict` too. Ids are the champion aliases of `champion-meta.json` (`Fiddlesticks`, `MonkeyKing`, `TwistedFate`); an id the current data does not know is an error in EVERY list here, including `exclusions` (the live converter reports such ids instead — a hand-authored file is expected to be current). An exclusion that names a champion already on the board loads with a warning.

## What the report prints

Per position, one block per arm (`pool_or_roster`, then `roster` at each P, ascending): the depth reached and whether it was cut, "searched k of N" (N = the legal root actions, k = the ranked ones), the size of the top set (how many actions tie within epsilon — at a ban root inside the horizon every ban ties on the BOARD, D3 iii), and the ranked top three with values (Blue-perspective: Blue maximises, Red minimises, so Red's best action carries the most negative value), each marked at a pick root `[in-pool]` or `[off-pool n]` (n = the champions it names outside the mover's pool; a champion with no FM row is `[padded: no FM row]`), how its principal continuation ends (`Complete` / `Horizon` / `DryPool`, both feasibility flags — the S11 guard: a line that breaks the mover's own side is a defect, one that breaks only the opponent is a denial — and both sides' off-pool counts, made plus forced). Then `actual_next` with its pool membership and its rank under every arm, as 1 + the number of strictly better actions (so a tie reads as a tie; "unsearched" if the shortlist cut it); the **break-even** from the roster sweep — the smallest P at which the top action is in-pool and the largest at which it is off-pool (or "in-pool at every P", "off-pool at every P", or "no off-pool question at a ban root"); the verdict's constraint on P when a verdict is given; and `review`.

The **summary** intersects every verdict: `off_pool: true` means P must sit below that position's smallest in-pool sweep P; `false` means above its largest off-pool sweep P. It prints the intersection over the sweep points (`P > lo and P < hi` — refine the sweep inside it), or names the conflicting positions when the intersection is empty, or says "no verdicts" — never a green line for an empty corpus. Arms that cannot speak are left out and said so (review round 1): a `partial` arm (the budget cut it), an arm whose top set mixes in-pool and off-pool actions (a tie broken canonically), a **non-monotone** sweep (the top is off-pool at some P above a P where it was in-pool — no single bound exists; refine the sweep), and a verdict whose bound lies outside the sweep is marked "widen the sweep" rather than read as a number.

## Calibrating P (B-proper § 3)

P is `engine_core::reference::universe::DEFAULT_OFF_POOL_COST` (0.15 blue-win logits, about 3.7 percentage points of win probability — an assumption, not a measurement). The procedure that replaces it:

1. Author positions where an off-pool pick tempts (`category: off-pool`), from your own prep; `docs/plans/2026-09-27-tier-b-smoke/gen_tierb.py` is the template. The four 2026-09-27 smoke positions are sweep inputs but keep `SMOKE` in `notes` — they are constructed, not corpus.
2. Run the report (a wider `TIER_B_P` sweep narrows the brackets, e.g. `0.02,0.05,0.1,0.15,0.2,0.3`).
3. Record `verdict.off_pool` per position — would you leave the pool here — and a line in `review`.
4. Read the summary's interval. Conflicts name the positions to re-read.
5. Set `DEFAULT_OFF_POOL_COST` in one commit that quotes the interval and the corpus size.
