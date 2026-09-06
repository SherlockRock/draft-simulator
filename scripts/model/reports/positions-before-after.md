# Positions refresh — before/after suggestion diff (design § 8 steps 5 and 5b)

**Date:** 2026-09-05 · **Tool:** `positions_before_after.py` (states built as `fm_search_ab.rs::prefix` builds the A/B's strata: real evaluable holdout drafts truncated to each pick turn, canonical role order, real bans, `__noban{i}` placeholders) · **Config:** production search (`branchWidth 5, pairBranchWidth 500, maxDepth 8, budget 5000 ms`, penalties 0.25/0.75, `DEFAULT_PHASE_WEIGHTS`) through the prebuilt `index.node` · **Old:** the committed `champion-meta.json` before the refresh (172 entries, Meraki positions) · **New:** the refreshed compile (173 entries, play-rate positions).

## Sample size and timing

The plan budgeted ~12 min for 31 states at ~10–13 s per request; measured, a production-config request through the probe averages **~57 s** (11 states × 2 arms = 22 requests in ~21 min: the full-roster pool of 173 champions and a fresh `node` + `index.node` load per request cost more than the Navigator's real pools). Per the plan's rule (> 30 min ⇒ shrink the sample and say so) the run is **one real draft per pick turn (11 states incl. the tour state) per seed**; a second seed is appended below when present. Numbers are therefore indicative, not a census.

## Step 5 — children under each meta (depth-1 requests, flat weights)

| state | old meta | new meta |
|---|---|---|
| tour § 6 `EUW1_7957728380`, red's last pick | 36 children | 36 children |
| `EUW1_7957730194`, red Ornn/Sylas/TwistedFate/Ezreal vs Camille/Elise/Mel/Xayah/Sona (infeasible under Meraki: Sylas had no JUNGLE/SUPPORT) | **0** (empty tree) | **36** |

333 red-side holdout states containing Sylas or Viktor flip from an empty tree to a populated one; the one above is the first in file order.

## Step 5b — production-config suggestion diff, seed 1 (11 states)

- **Every top-1 and every top-5 set changed (11/11).** Expected direction: 37 primaries re-ordered and mean listed roles 1.40 → 1.72 move `side_total`'s primary-role scoring, `missing_roles` specialist injection and coverage's 0.4-vs-1.0 factor on every state (design § 4, § 7 risks 1, 10, 11). None of the changes involves Locke.
- **Empty trees: 1 before → 1 after**, different states:
  - repaired — `EUW1_7961102304` turn 11 (red Fiddlesticks/Graves): Fiddlesticks gains SUPPORT and TOP, so two junglers can complete.
  - regressed — `KR_8351682342` turn 19 (red Rengar/Nidalee/Yone/Ezreal): Meraki listed Rengar TOP; his Master+ top share is under 10%, so the refresh dropped it (one of the 18 lost pairs) and Rengar + Nidalee are both jungle-only. This is the design's disclosed 717-state (2.10%) regression from lost roles (§ 3, § 7 risk 2); slice 2's `playable` floor at 0.02 is the remedy (13 states remain at that floor).
- Children counts also move at the top of the tree (9 → 8, 9 → 5, 34 → 36): the candidate set the search keeps at the root changes with the primaries.
- Eyeball of the top-1 changes: Braum → Pantheon (Pantheon's primary is now SUPPORT, 0.52), Pantheon → Swain, Seraphine → Zyra as the pair partner, Karma → Gwen, Blitzcrank → Poppy (Poppy's primary is now SUPPORT, 0.69), Swain → Leona. Each new top-1 is a champion whose listed roles or primary changed in the refresh; none is an off-role suggestion.

## Step 5b — seed 2 (11 more states, same construction)

- Again **11/11 top-1 and 11/11 top-5 changed**, 0 involve Locke; **empty trees 0 → 0**. Root children shrink on three late states (8 → 7, 9 → 7, 11 → 5) — the primary-keyed pool tiering and coverage compression the design predicted (§ 7 risks 1, 10). Top-1 changes: Swain/Teemo → Fiddlesticks/Viktor, TwistedFate → Katarina, Seraphine/Udyr → Alistar/Zyra, Hecarim → Senna, Twitch → Xerath, Senna → Xerath, Alistar/TwistedFate → Swain/Velkoz, Shen → Fiddlesticks, Pantheon → Rell — every incoming champion gained a role or a new primary in the refresh.

**Across both seeds (22 states): 22/22 top-1 changed, 22/22 top-5 changed, empty trees 1 → 1 (one repaired, one regressed via a lost role).** The suggestion set is a different one under play-rate positions; whether it is a better one is the question the design leaves to the product (§ 9 "score at the pool-assigned role" is the next engine PR), and the regressed state is slice 2's argument.

Raw rows follow (seed 1, then seed 2).

### Seed 1

| state | turn | children before | after | top-1 before | after | top-5 changed |
|---|---|---|---|---|---|---|
| tour §6 EUW1_7957728380 turn 19 | 19 | 9 | 8 | [['Braum']] | [['Pantheon']] | yes |
| KR_8354149971 turn 6 | 6 | 5 | 5 | [['Pantheon']] | [['Swain']] | yes |
| KR_8351406244 turn 7 | 7 | 36 | 36 | [['Gragas', 'Seraphine']] | [['Gragas', 'Zyra']] | yes |
| NA1_5626216919 turn 8 | 8 | 5 | 5 | [['Swain']] | [['Velkoz']] | yes |
| EUW1_7960542497 turn 9 | 9 | 36 | 36 | [['Senna', 'Zed']] | [['Zilean', 'Zyra']] | yes |
| KR_8350999395 turn 10 | 10 | 5 | 5 | [['Karma']] | [['Gwen']] | yes |
| EUW1_7961102304 turn 11 | 11 | 0 | 5 | [] | [['Cassiopeia']] | yes |
| KR_8351350461 turn 16 | 16 | 9 | 9 | [['Swain']] | [['Leona']] | yes |
| EUW1_7961006990 turn 17 | 17 | 34 | 36 | [['Seraphine', 'Taric']] | [['Velkoz', 'Zoe']] | yes |
| KR_8350205381 turn 18 | 18 | 9 | 5 | [['Blitzcrank']] | [['Poppy']] | yes |
| KR_8351682342 turn 19 | 19 | 9 | 0 | [['Alistar']] | [] | yes |

### Seed 2

| state | turn | children before | after | top-1 before | after | top-5 changed |
|---|---|---|---|---|---|---|
| tour §6 EUW1_7957728380 turn 19 | 19 | 9 | 8 | [['Braum']] | [['Pantheon']] | yes |
| EUW1_7958578853 turn 6 | 6 | 5 | 5 | [['Pantheon']] | [['Swain']] | yes |
| KR_8352123451 turn 7 | 7 | 35 | 36 | [['Swain', 'Teemo']] | [['Fiddlesticks', 'Viktor']] | yes |
| KR_8353495412 turn 8 | 8 | 5 | 5 | [['TwistedFate']] | [['Katarina']] | yes |
| KR_8352141601 turn 9 | 9 | 36 | 36 | [['Seraphine', 'Udyr']] | [['Alistar', 'Zyra']] | yes |
| KR_8350324078 turn 10 | 10 | 5 | 5 | [['Hecarim']] | [['Senna']] | yes |
| KR_8352734738 turn 11 | 11 | 5 | 5 | [['Twitch']] | [['Xerath']] | yes |
| NA1_5627010971 turn 16 | 16 | 8 | 7 | [['Senna']] | [['Xerath']] | yes |
| KR_8353473149 turn 17 | 17 | 36 | 36 | [['Alistar', 'TwistedFate']] | [['Swain', 'Velkoz']] | yes |
| KR_8351900403 turn 18 | 18 | 9 | 7 | [['Shen']] | [['Fiddlesticks']] | yes |
| KR_8353066015 turn 19 | 19 | 11 | 5 | [['Pantheon']] | [['Rell']] | yes |
