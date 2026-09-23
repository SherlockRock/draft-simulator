# Tier A fixtures

Controlled tactics on synthetic universes, judged by an exact oracle
(`engine_core::reference::oracle`). Design: `docs/designs/engine-tier-a-fixtures-design.md`;
spec: Obsidian `draft-simulator-engine-target` § 6. One JSON per fixture, all walked by
`tests/tier_a.rs`, which needs one named test per file.

Two checks per fixture: (1) the oracle's top set equals `expected_top` — proves the numbers
exhibit the tactic; (2) the reference search's top action is in the oracle's top set — proves
the engine (live since slice 4; `tests/tier_a.rs` also asserts the whole ranked list, every
horizon, the pruning/table switches, the budget property and the S11 guard).

## Fields

| field | meaning |
|---|---|
| `id`, `tactic`, `notes` | file stem, § 3 tactic number, what the numbers say and why the posing is what it is |
| `format` | `"standard"` (17 turns → the incumbent's 20 slots) or `{"turns": [{"side": "Blue"\|"Red", "kind": "ban"\|"pick"\|"pair"}, …]}` |
| `feasibility` | `"on"` only on formats with five picks a side (below five the predicate keeps only its count check — pool smaller than the remaining picks — and no role check); `"off"` anywhere, with the reason in `notes` |
| `universe.champions[]` | `{id, positions: ["Top"\|"Jungle"\|"Middle"\|"Adc"\|"Support", …], linear}` — every listed position is playable |
| `universe.synergy[]` | `{pair: [a, b], value}` — unordered, no duplicates, no self-pairs |
| `universe.counter[]` | `{of, over, value}` — `of` counters `over`; the reverse is `-value`; list each unordered pair once |
| `pools.blue`, `pools.red` | sets of ids; picks are gated by them, bans are not; 07b puts every available champion in both pools (66 root pairs) — the widest fan the suite has |
| `position[]` | one entry per filled slot: `{slot, side, kind: "ban"\|"pick"\|"skip", champion?}`; `slot` equals the index; `skip` only on ban slots |
| `oracle` | `"full_remainder"` or `{"horizon": h}`; explored depth ≤ 7 turns, ≤ 12 champions available |
| `expected_top` | ids for bans/picks, `[a, b]` for a pair; the author's intended top set (ties are exact) |
| `epsilon` | top-set tolerance, default `1e-9` |
| `dry_run` | `{value, leaves, nodes}` written by the Python prototype, asserted exactly; never hand-edited; regenerated 2026-09-14 under R1 by `2026-09-14-tier-a-oracle-prototype-r1.py` |

## Authoring rules learned the hard way

- Parameters are integers or halves so every sum is exact.
- A ban tactic roots at the banner's **last** ban before the opponent's next pick; earlier, the banner's own bans commute and every harmless ban ties (design S12).
- Under the slice-3 rule (terminate on infeasibility, both → 0) the side behind could force 0 by exhausting a role. Since slice 4 (R1: play on, leaf = board − L·[Blue inf] + L·[Red inf]) a role-exhausting pair is scored by the board after the opponent's answer, so the one-private-champion-per-role rule is a recommendation, not a requirement; 07b is the full-fan counterexample.
- A five-pick draft consumes twenty champions; inside the twelve-available bound, early standard-format positions cannot keep feasibility on.
- With `feasibility: "off"` nothing stops a pool from running dry mid-tree, and the oracle then aborts with `NoLegalAction` for the whole fixture. Every branch must keep a legal pick for the mover: a side's pool needs at least (its remaining picks + the bans that can hit it) champions. 06a sits exactly on that edge.
- Never edit `dry_run` to make a test pass. Regenerate with the prototype after changing a posing.
