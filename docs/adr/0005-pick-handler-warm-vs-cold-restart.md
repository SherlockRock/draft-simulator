# Pick handler chooses warm vs cold MCTS restart in JS

> **⚠️ SUPERSEDED 2026-06 — dormant reference.** Describes the MCTS streaming engine (pause/resume/warm-restart), removed when the navigator moved to αβ one-shot. The pick handler now always cold-restarts (cancel + fresh Compute); the warm-restart branch is gone. Retained as the reference design for a possible future αβ iterative-deepening streaming surface. Removed code is preserved in git tag `archive/mcts-spike`; decision arc in Obsidian `draft-simulator-mcts-spike`.

The backend `navigatorPick` and `navigatorBan` handlers decide whether to warm-restart the MCTS arena (via napi `applyPick`) or cold-restart it (via `supersedePriorCompute + startNavigatorSession`). The decision is made in JS, not Rust, by reading `entry.projectedChildren: Set<string>` — a per-session mirror of the latest-emitted snapshot's `tree.root.children[*].championIds`.

## Why JS-side

- The check is structural data ("is this championIds key in a Set?"). Pushing it into Rust would require a synchronous query API across the napi boundary on every pick, doubling round-trips.
- Failure mode (championIds slipped out of top-K between partial emit and pick arrival) is handled by JS fallback: napi `applyPick` returns `applyPick.notProjected` and JS catches → cold-restart.
- The Rust engine boundary stays minimal: one method (`applyPick(championIds)`) that warm-restarts or errors. JS owns the decision tree.

## projectedChildren mirroring cadence

Updated at the end of every `build_response`-derived snapshot emission: partial-emit and pause-finalize. Single source of truth per session entry; small memory cost bounded by `MAX_TOP_K_AT_ROOT`.

## Pair-pick atomicity

Pair-pick projected children carry two championIds (e.g. `["Kalista", "Braum"]`). The Set key is `championIds.join("|")`, so a pair child becomes `"Kalista|Braum"` — distinct from either solo `"Kalista"` or `"Braum"`. The frontend collapses today's two sequential `emitPick` calls into a single `emitPickStep(championIds, firstSlot)` so the backend sees the pair atomically.

## Consequence

A future reader adding warm-restart-eligible operations follows the same pattern: mirror projection state at emit time, key by joined champion-ids, fall back on Rust error.
