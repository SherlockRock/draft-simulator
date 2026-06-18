# Four layered defenses against stale paused Navigator Snapshots

> **⚠️ SUPERSEDED 2026-06 — dormant reference.** Describes the MCTS streaming engine (pause/resume/warm-restart), removed when the navigator moved to αβ one-shot. αβ one-shot has no paused snapshots, so this failure mode no longer exists. Retained as the reference design for a possible future αβ iterative-deepening streaming surface. Removed code is preserved in git tag `archive/mcts-spike`; decision arc in Obsidian `draft-simulator-mcts-spike`.

The "stale paused snapshot wins reload" failure mode has **four** distinct defenses. They are not redundant — each covers a different race window. Do not collapse them.

| # | Defense | Lives in | Window it covers |
|---|---|---|---|
| 1 | Pre-await guard on `endReason === "supersede"` | `pauseNavigatorSession` start | Supersession already declared when user clicks Stop. Pause short-circuits with `session-superseded`. |
| 2 | Post-DB-await re-check + inline `NavigatorSnapshot.destroy` | `pauseNavigatorSession` after persist | Supersession lands during the DB write. Row gets written, then deleted before broadcast. |
| 3 | `entry.lastPersistedPauseSnapshotId` tracking + `supersedePriorCompute` deletes it | `supersedePriorCompute` | Pause-persist completed and `.finally` cleared the promise, THEN supersession arrives. Defense 2 can't fire because the IIFE is done. |
| 4 | Frontend `after_event_id === latestEventId` gate in `hasPausedSession` | `NavigatorWorkflow.tsx` | Anything that survives 1–3: a stale paused row that lands in DB and gets fetched on reload. Refuses to surface it as paused. |

Plus a sequencing helper: `supersedePriorCompute` **awaits `pausePersistPromise`** before calling `end()`. Not cleanup — serialization that gives defenses 2 or 3 a chance to fire.

## Why all four

- Defense 4 exists because **same-event supersession** (forced-branch toggle, pool update on the Navigator Series) does not advance events. A bug in defenses 1–3 that lets a stale row through cannot be caught by "events have advanced past it" — the frontend gate is the only backstop for the same-event case.
- The frontend manages a complex visual representation of the data (socket events + persisted snapshots + optimistic reroot state). Backend defenses 2 and 3 exist so the frontend doesn't have to reason about stale data at all; defense 4 exists because the frontend can't fully trust the backend.
- Defenses 2 and 3 cover sequential timing windows (during DB write vs after DB write) that can't merge without a lock. Defense 1 is a fast-path short-circuit and costs nothing to keep.

## Consequence

Any future simplification ("we only need defenses 1 and 4") will silently regress one of the race windows. If same-event supersession sources are ever fully removed (forced-branch + pool-update changes always advance events), defense 4 can be reconsidered — until then, leave the layering intact.
