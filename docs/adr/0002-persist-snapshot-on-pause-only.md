# Persist Navigator Snapshot on Pause and disconnect only, not on End

> **⚠️ SUPERSEDED 2026-06 — dormant reference.** Describes the MCTS streaming engine (pause/resume/warm-restart), removed when the navigator moved to αβ one-shot. The αβ persist-every-successful-response policy noted below is the surviving behavior. Removed code is preserved in git tag `archive/mcts-spike`; decision arc in Obsidian `draft-simulator-mcts-spike`.

A **Navigator Snapshot** is persisted to the DB only when the user clicks Stop (Pause) or the socket disconnects. Natural End paths (supersession, shutdown) discard the final snapshot the iterate loop produces. αβ is a separate algorithm with a separate policy — αβ persists every successful response because αβ is one-shot, so "final" is a meaningful event there.

## Why

- The persisted snapshot exists for **UI continuity across reloads** — render the tree the user last saw — not for compute continuity. Persisting on supersede/shutdown would store snapshots the user has already moved on from, polluting the latest-snapshot lookup.
- The `meta.persistOnPause` flag drives the frontend's `hasPausedSession` derivation. If snapshots got persisted on End too, the frontend would need a second axis to distinguish "user paused this" from "we ended this without a user signal."
- αβ's "persist every final" is structurally different, not a legacy inconsistency: αβ has a meaningful concept of "output." MCTS only has Pause/disconnect as user-meaningful checkpoints.

## Consequence

The Mcts arena (nodes, visits, Q values) is in-memory only. Reload throws it away; Resume after reload starts a fresh Compute with `initialRootPath` set. Visits-lost-on-reload is an accepted limitation of this policy (locked design constraint).

## Future work

Compute continuity across reloads — full arena rehydration — is a future goal (see memory: arena rehydration). It will need to be thought through together with the WASM port direction (engine roadmap), since the WASM target changes what "process lifetime" means.
