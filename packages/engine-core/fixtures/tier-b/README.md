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
| `TIER_B_P` | `0.05,0.1,0.15` | the P values (blue-win logits) the `roster` arm sweeps; `0.1` is `DEFAULT_OFF_POOL_COST` |
| `TIER_B_WIDTHS` | `30,60,100` | the shortlist as `singles,pairs,root_off_pool` (B-proper § 2); every arm runs at the same widths |
| `TIER_B_HORIZON` | `2` | turns searched below the root (a pair is one) |
| `TIER_B_TOP` | `3` | ranked actions printed per arm |

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
| `pools` | `{ blue, red }`, optional; each side is a list `[id]` or a role map `{ top, jungle, mid, adc, support }` | each side's search pool. A **list** is a set: every champion counts as in-pool in any role the meta lets it play. A **role map** is the app's own shape (`Pools.champions`) and makes the pool role-aware — see "Role maps" below. The two sides are independent. A side's own picks already on the board are added automatically (a past off-pool pick is a fact, not a choice). **Absent = the whole roster on both sides** (a pro replay, D7: "no pools") |
| `exclusions` | `[id]`, default `[]` | cross-game exclusions (fearless): unavailable to both sides — never a ban, never a pick |
| `our_side` | `Blue` \| `Red`, optional | the side the rubric is read from |
| `actual_next` | id, `[a, b]` at a pair start, or absent | what was actually played next — the soft comparison point, never truth; the report says whether it was in the pool |
| `review` | string, default `""` | rubric verdicts in prose, appended per reading |
| `verdict` | `{ "off_pool": true \| false }`, optional | **would you leave the pool here** — the one structured verdict, read by the calibration summary (below); meaningful at a pick root only |
| `verdicts` | `[entry]`, optional, **append-only** | the graded verdicts of the review tool (below). Written only by `pnpm tier-b:apply`, never by hand; at a ban root it is a warning and is not read. Sits immediately before `review` |
| `capture` | object with a string `protocolVersion`, optional | the raw captured request (the wire `EngineRequest` once the capture button exists), kept opaque so nothing the loader does not model (display pools, tiers) is lost. **Provenance only: the top-level `pools` / `exclusions` are the position**; when the capture's search pools or `crossGameExclusions` differ from them the loader warns and uses the top-level fields. A role-map side is compared with the capture's `display` map, role by role; a list side with its `search` list |

Unknown fields are rejected (`deny_unknown_fields`), inside `verdict` too. Ids are the champion aliases of `champion-meta.json` (`Fiddlesticks`, `MonkeyKing`, `TwistedFate`); an id the current data does not know is an error in EVERY list here, including `exclusions` (the live converter reports such ids instead — a hand-authored file is expected to be current). An exclusion that names a champion already on the board loads with a warning.

## Role maps

A role map lists a side's champions under the role its player pilots them in:

```json
"pools": {
  "blue": { "top": ["Garen", "Jax"], "jungle": ["JarvanIV", "Jax"], "mid": ["Viktor"], "adc": ["Jhin"], "support": ["Bard"] },
  "red": ["Aatrox", "Vi", "Sylas", "Jinx", "Nautilus"]
}
```

- **Exactly five keys**: `top`, `jungle`, `mid`, `adc`, `support` (the app's spelling: `adc`, not the meta's `BOTTOM`; `mid`, not `middle`). All five are required; an empty list is allowed; any other key is an error, as is an unknown champion — each named with its location (`pools.blue.mid`).
- **Off-role is off-pool.** A champion placed in a role its entry does not list costs P exactly like a champion outside the pool. The count is taken over the cheapest role arrangement of the side's picks, so a pick already on the board that a later pick pushes off its listed role is charged, once. (Picks that cannot be arranged in five distinct roles at all have no arrangement to count: that board is priced by the infeasibility band, and the count falls back to the champions outside the pool entirely.)
- **A champion may sit under several roles** and is in-pool for each.
- **An entry under a role the meta does not list is honoured**: it makes that role playable for that side (and for that side only). The loader records a note for each such entry and the report prints it.
- **Board picks**: one the map lists keeps its listed roles; one the map omits is added under every role the meta lists for it, so it is never charged.
- Role maps are read under the live rules (`pool_or_roster`, `roster`). A Tier A fixture takes list form only, and a search under `on` / `off` refuses a role-tagged pool.

### Graded off-role cost (engine slice 8, `roster` only)

Under `roster` a champion placed outside its pool entries pays P, and — in a secondary meta role — a further `grade · Q / 100`, where `grade = round(100 · (1 − share(role) / share(primary)))` from the Master+ play shares the positions refresh ships beside `positions` as `positionShares` (0 at the primary, 100 at a role never played, 0 everywhere for a champion whose shares are unknown). Q is `engine_core::reference::universe::DEFAULT_OFF_ROLE_COST` (0.05 logits, an assumption pending the sweep below; `TIER_B_Q` sweeps it). What the grade never touches: legality, the pool test and the `[in-pool]` / `[off-pool n]` class read today's unweighted arrangement; a pool entry is never graded, whatever role it lists (an entry under a non-meta role is in-role for that side); a board pick the map omits is never charged; the forced term (picks still to come the pool cannot fill in-role) is P each at grade 0 — a lower bound; `pool_or_roster` charges Q = 0 and a list-form side is never graded. At Q = 0 every `roster` number is slice 7's bit for bit. The leaf charges the least TOTAL over the arrangements of the side's picks — one comparator, price first — and reports that arrangement's own split (`made`, `grade`, `forced`), so `made` can exceed today's count at Q > 0: the cheapest completion places a locked pick off-role to avoid a grade. The marker adds ` · grade g` when the key's grade delta is non-zero and, per off-pool champion of the action, ` as adc r 0.29` — the role the KEY priced (the cheapest arrangement of the locked picks plus the action) with `r = share(role) / share(primary)`; the leaf's arrangement can differ wherever picks remain (they coincide on a complete five-pick side).

## The graded review (the review tool)

Design `docs/designs/tier-b-review-tool-design.md`, plan `docs/plans/2026-11-08-tier-b-review-tool-plan.md`. It replaces the one-bit read (`verdict.off_pool`, `role_verdict.ok`) with a label per option, over the options the reference engine puts in view. **The old report, `verdict`, `role_verdict` and the interval they give stand as history, reading the frozen fields: the tool never writes or derives them, and the old command still prints the interval** (on the `playable` mask it reads EMPTY, see 2026-10-12 above).

### The loop

```
pnpm tier-b:review                              # run -> page: docs/plans/<date>-tier-b-review/<run id, colons as dashes>/{run.json,review.html}
  ... open review.html, label blind, reveal a draft, Copy verdicts (or Download) ...
pnpm tier-b:apply <verdicts.json>               # write the export into the fixtures, then run tier-b:review again
pnpm test:tier-b                                # the Node tests
```

`tier-b:review` also writes `summary.txt` beside `run.json` and prints it (the terminal copy collapses the worklist to counts per position; `summary.txt` holds every row), and takes `--record` (below). It takes `--fixtures <dir>` (a copy of the corpus; `tier-b:apply` forwards it to its rerun, so a temp-corpus apply never reruns the real corpus). `tier-b:apply` also takes `--no-review`; it prints per position what it did (`wrote …`, `replay`, `older`, `stale`, `refused`) and exits non-zero if any position was refused. Apply the page's export at the end of each sitting: every export is cumulative and the newest supersedes the rest, a replay writes nothing, and an older export of the same run is not applied (apply keeps a run-wide high-water mark: the highest `rev` of that run already written on any position, so it holds even for a position whose own last change was reverted; the one gap is an applied export that wrote nothing anywhere, which leaves no mark, so apply only your newest export), and an export from a page built before another run's entries landed is refused as stale (build a fresh page). Every entry is checked against the loader's rules before anything is written; a position that would fail is refused by name and left byte-identical.

**Continue on the new page.** After an apply, work on the NEW page the apply prints, never the old one: an old page cannot know that a draft was revealed elsewhere, so a blind label made there after a reveal elsewhere is refused (or, on another card, would not really be blind). "Copy verdicts" puts the export on the clipboard; save it to a file before `tier-b:apply`, which has no stdin. The Download button is the simpler habit. A relative export path (and `--fixtures`) is read from the directory you ran `pnpm` in. Each rerun keeps its run directory under `docs/plans/` (about 50 MB, mostly `run.json`, the record of what the page showed) and prints its size; nothing deletes it.

### `verdicts`

An entry holds only what it adds or changes; entries are read in file order.

| key | type | meaning |
|---|---|---|
| `started`, `finished` | ISO-8601 UTC | wall-clock bounds of the changes in this mode (a span includes any break) |
| `mode` | `blind` \| `scored` | `blind`: the draft had never been revealed. Once any card of a draft holds a `scored` entry, every later label on that draft is `scored`; a `blind` entry after a `scored` one fails the load |
| `from` | `{ run, rev }` | the page state that wrote it: the run id and the page's revision counter (apply's replay and staleness checks) |
| `fm_version`, `positions_patch` | string | the data the page was built on (from the export, never the current files) |
| `would_pick` | id, `[a, b]` at a pair root, or `null` | the reader's own pick, given before seeing the engine. **Absent leaves the pick as it was; `null` is an answer ("no view")**. A pair compares as a set |
| `labels` | `{ <option id>: play \| maybe \| never }` | the labels this entry adds or changes. Empty on an entry that carries only an own pick, a line verdict or a note; an empty `scored` entry with none of those is the record of a reveal that changed nothing, written once |
| `line` | `{ option, line, ok }`, `scored` only | the verdict on the reference #1's line (one `ok` / not click at reveal; the `line` text is the run's, verbatim). Never enters the rule |
| `note` | string | the card's free-text note |

**Option id**: the action's champion ids sorted (byte order) and joined with `+`, then `|` and the mover's whole side as `role=id` pairs in the order top, jungle, mid, adc, support: `Renata+Ziggs|top=Camille,jungle=LeeSin,mid=Galio,adc=Ziggs,support=Renata`. The comp is the mover's locked picks plus the action, each once; where no role information exists the id is the action alone. Ids are copied from the run, never built by hand.

**Two folds.** *Current* is the last label written for each option in any mode; *blind* is the last written in a `blind` entry (a `scored` entry never changes it). The own pick folds the same two ways. A line verdict folds by (option, line text), last write winning. The folds exist twice, in the loader and in `scripts/tier-b/apply-verdicts.mjs`; `tests/data/tier-b-review/fold-vectors.json` is read by both test suites.

### The labels (the rubric)

A label judges a side on this board, **for this team with these pools**, ignoring P, Q and the engine's line.

- `play`: happy to pick this here. On an off-pool option: I would leave the pool for this here.
- `maybe`: defensible, with a caveat. On an off-pool option: I could leave the pool for this, with a caveat.
- `never`: on an in-pool option, I would not pick this here, even though we can play it. On an off-pool option, absurd in that role, or not worth leaving the pool.
- At early slots the side is incomplete: assume competent follow-up from this pool, and judge a flex on the champion, not on the role shown.
- The **own pick** is what you would play, given before seeing anything from the engine; `null` ("no view") is an answer.

D7 asks for a rubric written before reviewing; its three questions map onto the tool like this:

| D7 question | where it is answered |
|---|---|
| Is the top action defensible? | the label on the engine's #1: `never@1` |
| Is anything absurd in the top three? | the labels on the top three: `never@3` |
| Does the continuation read like a draft? | the line verdict on the reference #1 (`ok` / not), at reveal; slot 19 has none |

Slice 2 of the plan adds the results table and the pre-registered rule that read these labels; until then the page is the product.

## What the report prints

Per position, one block per arm (`pool_or_roster`, then `roster` at each P, ascending): the depth reached and whether it was cut, "searched k of N" (N = the legal root actions, k = the ranked ones), the size of the top set (how many actions tie within epsilon — at a ban root inside the horizon every ban ties on the BOARD, D3 iii), and the ranked top three with values (Blue-perspective: Blue maximises, Red minimises, so Red's best action carries the most negative value), each marked at a pick root `[in-pool]` or `[off-pool n]` (n = the action's charge: the off-pool picks it adds for the mover — under a list the champions it names outside the pool, under a role map the rise in the off-role count, never below the champions it names outside the pool; a champion with no FM row is `[padded: no FM row]`), how its principal continuation ends (`Complete` / `Horizon` / `DryPool`, both feasibility flags — the S11 guard: a line that breaks the mover's own side is a defect, one that breaks only the opponent is a denial — and both sides' off-pool counts, made plus forced). Then `actual_next` with its pool membership and its rank under every arm, as 1 + the number of strictly better actions (so a tie reads as a tie; "unsearched" if the shortlist cut it); the **break-even** from the roster sweep — the smallest P at which the top action is in-pool and the largest at which it is off-pool (or "in-pool at every P", "off-pool at every P", or "no off-pool question at a ban root"); the verdict's constraint on P when a verdict is given; and `review`.

Each roster arm line names the top's class — `in-pool`, `off-pool base` (no grade anywhere in the action's placements and no grade delta in the key) or `off-pool graded` — PER ARM: only the in-pool half is Q-independent. The ending column adds both sides' grade units (`grade 0 71`), the leaf's own.

The **summary** intersects every verdict: `off_pool: true` means P must sit below that position's smallest in-pool sweep P; `false` means above its largest off-pool sweep P. It prints the intersection over the sweep points (`P > lo and P < hi` — refine the sweep inside it), or names the conflicting positions when the intersection is empty, or says "no verdicts" — never a green line for an empty corpus — or, when verdicts exist but none can bound P, "no usable verdict — nothing to calibrate against", or, when some can and some cannot, "N verdict(s) could not bound P: …" naming them. Arms that cannot speak are left out and said so (review round 1): a `partial` arm (the budget cut it), an arm whose top set mixes in-pool and off-pool actions (a tie broken canonically), a **non-monotone** sweep (the top is off-pool at some P above a P where it was in-pool — no single bound exists; refine the sweep), and a verdict whose bound lies outside the sweep is marked "widen the sweep" rather than read as a number.

## Calibrating P and Q (the current procedure)

Design `docs/designs/tier-b-review-tool-design.md` § 4 and § 5. P and Q are read together, off graded labels, by a rule registered before any real label existed; the older one-bit procedures below stand as history.

1. **Review.** `pnpm tier-b:review`. The run carries every arm of the grid (`roster` at each P and Q, the `pool_or_roster` arm, the reference arm at the defaults) and, once any position is labelled, a `metrics` block; `summary.txt` beside `run.json` is its text form, and the page's results tab reads the same block. A run with no labels has no `metrics` and its summary says so.
2. **Read the summary.** The P x Q table (`never@1 / never@3 / pick@3` per cell; `(+n)` near ties the rule does not read; `≥n` where unjudged options leave the count a lower bound; `*` the rule's pick, `^` the reference arm). Then the two floor rows (the reference ranking with options holding an off-pool placement below r 0.10 and 0.25 removed: "floor the role" against "raise Q"; never selectable), the rule's line (`N of 48 arms readable`, or that none is, with the worklist), the receipt (the pick against the reference arm on every metric, and which own picks leave the top 3), the sensitivity line (the pick at other margins and with each draft left out), the second line (the rule on the current fold, flagged if it differs), `never_everywhere`, `r_by_label`, `reveal_changes`, `bad_line@1` ("bad of judged": an unjudged line is not a good one) and the worklist (unlabelled rows per position; the #1 lines at the pick with no line verdict). The rule reads the blind fold, falling back to the current label per option; the summary counts those. A floor row prints how many positions do not speak at it and how many unknown-r placements it kept.
3. **The default change, if there is one,** is its own commit, setting `DEFAULT_OFF_POOL_COST` and/or `DEFAULT_OFF_ROLE_COST`, and its message quotes the table, the corpus size and the data version (`run.data` in `run.json`, also on the `history.jsonl` line). The rule only recommends; the decision is the user's. A pick on the grid's edge says so; read `r_by_label` and the floor rows before widening.

**`--record`.** Commit the working tree first: the line's `dirty` flag reads true over uncommitted engine changes (the fixtures are left out of that check), and its `commit` would then name a commit that did not produce the read. `pnpm tier-b:review --record` appends exactly one JSON line to `history.jsonl` in this directory (or in the `--fixtures` directory), after the run and the page have both succeeded: date, run id, commit and dirty flag, data versions, grid, corpus size, label counts, the reference arm's metrics, and the rule's pick with its edge flags. A failed run appends nothing, and a run with no labels refuses to record. The file is tracked and only ever appended to; `--record` does not add it to git, so commit `history.jsonl` after the recording (its own commit, or with the default change if there is one): it is what answers, months on, whether a slice or patch made the read worse, without re-running old commits. `load_dir` reads `*.json` only, so `history.jsonl` is never loaded as a position.

The two procedures below are **history**: they read the frozen one-bit fields (`verdict.off_pool`, `role_verdict.ok`) and stand as the record of how P = 0.10 and Q = 0.05 were set.

## Calibrating P (B-proper § 3), history

P is `engine_core::reference::universe::DEFAULT_OFF_POOL_COST`: 0.10 blue-win logits (about 2.5 percentage points of win probability). First calibrated 2026-09-29 on list pools (seven verdicts, P > 0.09 and P < 0.11; it replaced the 0.15 assumption). Recalibrated 2026-10-04 on role maps: the `2026-09-29-*` + `2026-10-04-*` corpus, 21 positions (the five parked September boards as recorded, three continuations re-derived under role maps with the user's veto, six engine-selected earlier stops where an off-pool option tempted at P = 0), 20 verdicts (one dropped: it could not bound P), 19 consistent with 0.10 < P < 0.11 at a 0.01 step; the one kept conflict is the re-derived supp-19. The user kept 0.10. The verdicts were given on a scored read (the engine's P = 0 ranking beside each board), not blind, and the meta's loose position lists put roster options in the ranking that a team would never play — a secondary-role option was the engine's top on 4 of the 21 positions and in its top 3 on 8. That is what the graded off-role cost prices (engine slice 8); re-read P once Q is calibrated (loose position lists are priced by the grade; Camille's SUPPORT primary was a 16.15/16.16 pooling artefact, fixed by the positions refresh's recency rule). **Re-read 2026-10-08 at Q = 0.05 on the 16.19 table** (`TIER_B_P=0.08,0.09,0.1,0.105,0.11,0.12,0.15 TIER_B_Q=0.05`, 24 positions, 20 verdicts; `docs/plans/2026-10-07-q-calibration-a/report-p-reread-q005.txt`): `P > 0.1 and P < 0.105` — the lower edge is 09-29 top-16's stay (top off-pool at P ≤ 0.1), the upper edge 10-04 supp-17's leave (top in-pool at P ≥ 0.105); the same shape as 2026-10-04, so P = 0.10 stands. The procedure:

1. Author positions where an off-pool pick tempts (`category: off-pool`), from your own prep; `docs/plans/2026-09-27-tier-b-smoke/gen_tierb.py` is the template. The four 2026-09-27 smoke positions live under `tests/data/tier-b/` (constructed, not corpus) and are NOT sweep inputs: the report reads `fixtures/tier-b/` only.
2. Run the report (a wider `TIER_B_P` sweep narrows the brackets, e.g. `0.02,0.05,0.1,0.15,0.2,0.3`). `TIER_B_Q` defaults to `DEFAULT_OFF_ROLE_COST` (0.05) since engine slice 8, so a P sweep now prices every roster arm at that Q; set `TIER_B_Q=0` to reproduce the 2026-10-04 reading (the unpriced roster, P alone).
3. Record `verdict.off_pool` per position — would you leave the pool here — and a line in `review`.
4. Read the summary's interval. Conflicts name the positions to re-read.
5. Set `DEFAULT_OFF_POOL_COST` in one commit that quotes the interval and the corpus size.

## Calibrating Q (engine-role-grade § 6), history

Q is `DEFAULT_OFF_ROLE_COST`, 0.05 logits per 100 grade units — calibrated 2026-10-07/08 on the 16.19 recency table (24 positions, 5 role verdicts at P = 0.105; record `docs/plans/2026-10-07-q-calibration-a/REPORT.md`): upper bounds Q < 0.045 (10-04 top-19 Lissandra-top ok), < 0.08 (09-29 supp-19 Karthus-adc ok; the 09-29 leaves), < 0.12 / < 0.15 (the two synthetic DME slot-17 positions); the one lower bound Q > 0.045 (10-04 supp-17 Renata+Syndra, Syndra at adc, ok = false) — the two user verdicts straddle 0.045 by ≈ 0.007 logits, so the strict interval is empty at that resolution and the user KEPT 0.05 (the Syndra rejection honoured; Kayle shown instead of Lissandra). Fix P at 0.105 (strictly inside the calibrated P interval: top-16 flips at P ≈ 0.1004, mid-19's Annie at ≈ 0.1061) and sweep Q alone: `TIER_B_P=0.105 TIER_B_Q=0,0.02,0.05,0.08,0.1,0.15 cargo test --release --test tier_b -- --ignored --nocapture tier_b_report`. With one P and several Q the break-even and every verdict read over Q; with several of both the report reads per Q column and bounds nothing. What a verdict can say about Q:

- `verdict.off_pool: true` ("leave") is satisfied by any off-pool top, graded or not — it bounds Q from ABOVE only (below the smallest Q at which the top is in-pool).
- `verdict.off_pool: false` ("stay") bounds Q from below only where the top is GRADED. A stay that no sampled Q satisfies prints `unsatisfied at every sampled Q; the top at the largest Q is <class>` — an observation over the samples, never a reachability claim: monotonicity in Q is not assumed at any depth (a winning grade can RISE with Q through the opponent's pricing), and at horizon ≥ 2 ANY top — in-pool or base included — can move with Q through its continuation's grades: on the grid's smoke-2 root at widths 15/25/50 the in-pool pair MonkeyKing+Sylas, whose line later places Zyra at adc, gives way to MonkeyKing+Zeri at Q = 0.05 (at widths 30/60/100 the Q = 0 top there is already an off-pool pair). The bound shapes assume in-pool at the larger Q; a top that moves the other way reads `NON-MONOTONE` and bounds nothing — read the per-Q columns. `NonMonotone` samples get no bound, as for P.
- **`role_verdict: { "action": "Zyra", "roles": ["adc"], "ok": false }`** — the verdict on a GRADED top: would you play THIS action in THESE roles (one role key per champion of the action, in the action's order; a pair names both). Read over Q alone, through the same shapes: `ok: false` wants Q above every sampled Q at which the judged action, in the judged roles, is the top; `ok: true` wants Q below them; a set that is top at Q₁ and Q₃ but not Q₂ is non-monotone and bounds nothing. A role verdict whose action is never a graded top at any sampled Q is warned and skipped (either it was never the top at any sampled Q, or its own placements carry no grade, so nothing the verdict judges is priced by Q — whatever its continuation does); a graded top the user never judged — another action, or the judged action in other roles — prints `new graded top, unjudged` / `roles differ, unjudged` and bounds nothing. Without this field the corpus has NO lower bound on Q on the 16.19 table (the re-derived supp-19's Zyra-at-adc line — Zyra at adc until Q ≈ 0.077, Ashe after — existed only on the 16.15/16.16 table, where Zyra still listed BOTTOM; the frozen-table probe test keeps that reading as a regression pin). The only lower bound today is a `role_verdict` (10-04 supp-17's Syndra at adc).

The recency re-export happened before the calibration (main `9b652b3` merged 2026-10-07, shares regenerated on the branch from the 16.19 deciding patch; Shen, Camille and Xerath carry their 16.19 primaries). Eight tests that pin values measured on the old table read the FROZEN `tests/data/champion-meta-2026-09-05-positions.json` (`frozen()` in `tests/common/mod.rs`); the report runner and every other test read the live table. Any future change to `DEFAULT_OFF_ROLE_COST` goes in one commit that quotes the interval, the corpus size and the data version the shares came from.

**2026-10-12 — both intervals were read on the LISTED mask and are not yet re-read on `playable`.** Champion-role-shares slice A widened the TAGGED side's legality to each champion's `playable` set (the listed roles plus every role with ≥ 10 picks per 10,000 train games of the deciding patch; `docs/designs/champion-role-shares-design.md` § 5.3): a playable-but-unlisted roster placement is now legal at P + grade·Q/100 instead of illegal. On the slice-A dry run the same 23 fixtures read **EMPTY** for both intervals (Q at P 0.105: `Q > 0.05` from 10-04 supp-19 Kittens' stay against `Q < 0.02` from 10-04 supp-17 DME's leave; P at Q 0.05: `P > 0.11` against `P < 0.095`), with two `new graded top, unjudged` lines — Zyra at adc (r 0.13, grade 87) on 09-29 supp-19 and Rek'Sai at top (r 0.08, grade 92) on 10-04 top-19. The P and Q above stand as calibrated on the listed mask; the re-read on `playable` (judge the two new graded tops as `role_verdict`s first) is the calibration owner's, after slice B.
