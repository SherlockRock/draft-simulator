# Tier B — real positions

Spec: Obsidian `draft-simulator-engine-target` § 3 (Tier B) and D7; design `docs/designs/engine-live-universe-design.md` § 6 (slice 5).

One JSON per position, hand-authored by the user from their own prep ("I had a real decision here") — later pro positions in a second pass. **No expected outputs**: a Tier B file carries the position, the pools and soft annotations; the engine's answer is read by a human against the rubric, never asserted. The reader is the user until a second reader exists; verdicts go in `review`, one line per reading, so a second reader is additive.

The loader (`engine_core::reference::tier_b`) validates a file against the **current** live universe (`fm-weights.json` + `champion-meta.json`). Ids are strict here (a typo in a hand-authored file fails loudly). A `source` version that differs from the loaded data is a warning, not an error — a Tier B position is meant to be re-read against current data; an `actual_next` the reference could not generate (already on the board, excluded, or outside a pool that can still finish) is a warning too.

Run the report: `cargo test --release -p engine-core --test tier_b -- --ignored --nocapture tier_b_report`. It is `#[ignore]` by design: a report, never a gate, and an empty directory must never be green. It searches under the live feasibility rule `pool_or_roster` (design U10): a side picks from its pool while the pool can still complete its comp, and from the whole roster once it cannot, each off-pool pick (made, or forced still to come) costing a flat P = L — more than any board swing, so the rule is lexicographic: the engine never suggests an off-pool pick while the pool can finish, however strong the champion (a board-comparable P is a Tier B calibration). A side that cannot finish even from the roster pays the wider L' = L + 10P, so breaking one's own comp alone is never worth an off-pool pick saved (a line that breaks BOTH sides is R1's board plus the netted off-pool term — the S11 residual). A position where a side's LOCKED picks already cannot fill five roles (two ADC-only champions paired) is still ranked under this rule, that side in the L' band on every line; the gate would refuse it. A Tier A fixture may not declare this rule.

## Fields

| field | type | rule |
|---|---|---|
| `id` | string | file name without `.json`; date-prefixed (`2026-10-03-red-pick-slot-11-vs-t1`) |
| `category` | `pro-replay` \| `counter-pick` \| `flex-retention` \| `pair-coherence` \| `edge-case` | D7's tags |
| `notes` | string | why this was a real decision |
| `source` | `{ fm_version, meta_version, captured, session? }` | the data the position was captured on; `session` is the Navigator session id when there is one |
| `format` | `"standard"` | the only format this slice loads |
| `position` | `[{ slot, side, kind, champion? }]` | slot = index; `side` is `Blue`/`Red`; `kind` is `ban`, `pick` or `skip`; a `skip` (a forfeited ban) is legal on ban slots only and names no champion |
| `pools` | `{ blue: [id], red: [id] }`, optional | each side's search pool as a set; a side's own picks already on the board are added automatically (a past off-pool pick is a fact, not a choice). **Absent = the whole roster on both sides** (a pro replay, D7: "no pools") |
| `exclusions` | `[id]`, default `[]` | cross-game exclusions (fearless): unavailable to both sides — never a ban, never a pick |
| `our_side` | `Blue` \| `Red`, optional | the side the rubric is read from |
| `actual_next` | id, `[a, b]` at a pair start, or absent | what was actually played next — the soft comparison point, never truth |
| `review` | string, default `""` | rubric verdicts, appended per reading |
| `capture` | object with a string `protocolVersion`, optional | the raw captured request (the wire `EngineRequest` once the capture button exists), kept opaque so nothing the loader does not model (display pools, tiers) is lost. **Provenance only: the top-level `pools` / `exclusions` are the position**; when the capture's search pools or `crossGameExclusions` differ from them the loader warns and uses the top-level fields |

Unknown fields are rejected (`deny_unknown_fields`). Ids are the champion aliases of `champion-meta.json` (`Fiddlesticks`, `MonkeyKing`, `TwistedFate`); an id the current data does not know is an error in EVERY list here, including `exclusions` (the live converter reports such ids instead — a hand-authored file is expected to be current). An exclusion that names a champion already on the board loads with a warning.

## What the report prints

Per position: the size of the top set (how many actions tie within epsilon — at a ban root inside the horizon every ban ties on the BOARD, D3 iii; under the live rule a ban can still move a side's off-pool forecast), the ranked top three with values (Blue-perspective: Blue maximises, Red minimises, so Red's best action carries the most negative value; a champion with no FM row is marked `[padded]`, and at a pick root a pick outside the mover's pool — legal only because the pool could not finish — is marked `[off-pool]`), how each principal continuation ends (`Complete` / `Horizon` / `DryPool` and both feasibility flags — the S11 guard: a line that breaks the mover's own side is a defect, one that breaks only the opponent is a denial), the rank of `actual_next` as 1 + the number of strictly better actions (so a tie reads as a tie), and the band the top line sits in, read off its ending: the feasible band; the off-pool band (forced off-pool picks, P each — a forced opponent is the live form of denial); the L' band (one side cannot finish even from the roster — a defect if it is the mover's, a denial if the opponent's); or both sides broken (R1's board — the S11 residual).
