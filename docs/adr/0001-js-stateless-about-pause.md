# JS Compute layer is intentionally stateless about pause

> **⚠️ SUPERSEDED 2026-06 — dormant reference.** Describes the MCTS streaming engine (pause/resume/warm-restart), removed when the navigator moved to αβ one-shot. Retained as the reference design for a possible future αβ iterative-deepening streaming surface. Removed code is preserved in git tag `archive/mcts-spike`; decision arc in Obsidian `draft-simulator-mcts-spike`.

The JS-side `entry` in `activeSessions` deliberately omits any `state: 'active'|'paused'|'ending'` field. Pause-truth lives in Rust (`LoopState`, runtime) and in the persisted **Navigator Snapshot** (`meta.persistOnPause`, cross-process / reload). JS only tracks the in-flight pause-persist via `pausePersistPromise` and the End reason via `endReason` (renamed from `stopReason` on 2026-06; the three values `user`/`supersede`/`disconnect` are all End reasons, not Pause reasons).

## Why

- No JS code path needs to ask "is this Compute paused?" — `resumeNavigatorSession`, `supersedePriorCompute`, and the disconnect handler all work correctly without that information, because they route commands and let Rust handle pause-while-paused / resume-while-active as no-ops.
- Adding an `entry.state` mirror of Rust would create a third source of truth that must stay in sync across every Pause / Resume / End / reroot path. The Phase-7c R3-2 fix already shows how easy it is to miss a single state reset.
- Pause-truth is read in two distinct places, neither of which is JS: the iterate loop body (Rust) and the persisted-snapshot-driven UI (Frontend).

## Consequence

A future reader who reflexively adds `entry.state` for "symmetry with Rust" is regressing the design. If a JS-side caller ever genuinely needs to know "is this paused right now," the right answer is either to push the decision into Rust (which already knows) or to read the latest persisted snapshot — not to mirror state in JS.
