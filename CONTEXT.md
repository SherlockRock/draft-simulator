# First Pick — Project Context

Glossary and conceptual model for the **First Pick** (formerly Draft Simulator) codebase.
Implementation details live in source and design docs; this file defines the language only.

## Language

### Navigator (live in-draft minimax tool)

**Navigator Series** (DB: `NavigatorSession`):
A user-named, series-spanning context. Fixes once per series: our side, blue/red/opponent pools, draft mode (standard / fearless / ironman), series length (1/3/5/7). Owns N **Navigator Drafts**.
_Avoid_: just "session" (ambiguous — see Flagged ambiguities).

**Navigator Draft** (DB: `NavigatorDraft`):
One game within a **Navigator Series**. Wraps a shared **Draft** by FK; has its own events and snapshots. Carries `game_number` and an optional `our_side_override`.

**Draft** (DB: `Draft`):
The shared 20-slot pick/ban model used by Canvas, Versus, AND Navigator. Navigator never owns a Draft directly — always via a **Navigator Draft** wrapper.

**Navigator Event**:
A real ban or pick that landed in a **Navigator Draft**. Source of truth for "what's happened in this game so far"; consumed by the engine to build `draftState`.

**Navigator Snapshot**:
A persisted engine output for one **Navigator Draft** at one point in time. Carries the pruned tree, scenarios, and meta. Latest snapshot whose `after_event_id` matches the latest event is the one the UI renders.

**Compute** (in-memory only, napi Rust handle):
One MCTS (or αβ) iteration thread for the *current* **Navigator Draft** within an active **Navigator Series**. Tracked JS-side as an entry in `activeSessions`, keyed by **Navigator Series** id. At most one Compute per Series. Lifecycle: started → (Active ↔ Paused) → Ended.
_Avoid_: "Session" or "Navigator Session" — those are the DB Series, not the compute.

**Stop** (UI):
The user-facing verb for "halt iteration but keep what you've found." Internally a **Pause** — the Rust MCTS arena is retained, a snapshot is persisted, and the affordance toggles to **Resume**.

**Pause** (internal):
The actual lifecycle transition behind a Stop click. Rust enters `LoopState::Paused`; a `meta.persistOnPause: true` snapshot is written; the frontend derives `hasPausedSession` from that flag plus a freshness gate.

**End** (internal):
Permanent teardown of a **Compute** — cancel flag set, iterate thread exits, `activeSessions` entry deleted. Triggered by supersession, socket disconnect, or shutdown.

**Supersession**:
A new **Compute** replacing a prior in-flight one for the same **Navigator Series**.
- _Pick-advance supersession_ — a real **Navigator Event** landed; `events.length` grew. The pick handler may warm-restart the in-flight Compute via napi `applyPick` if the new championIds match a top-level projected child (see ADR-0005); otherwise it cold-restarts via a fresh Compute.
- _Same-event supersession_ — algorithm toggle / forced branch / pool update changed compute parameters without advancing events. (The case the frontend `after_event_id` gate cannot detect on its own.)
- _Draft-switch supersession_ — user navigates to a different **Navigator Draft** within the same series; same key, different game.

## Relationships

- One **User** owns many **Navigator Series**.
- One **Navigator Series** has many **Navigator Drafts** (one per `game_number`).
- One **Navigator Draft** wraps one **Draft** (shared model).
- One **Navigator Draft** has many **Navigator Events** and many **Navigator Snapshots**.
- At any moment a Series has *at most one* live **Compute** (in-memory, not in DB).
- A **Compute** is *for* one **Navigator Draft** at a time; switching drafts within a Series supersedes.

## Flagged ambiguities

- **"session"**: overloaded across three layers — (1) `NavigatorSession` DB model = the Series, (2) napi `NavigatorSession` struct = a single Compute, (3) "sessionId" in socket events / `activeSessions` map = the Series id. Canonical: call the DB row a **Navigator Series**, call the in-memory thread a **Compute**. Rust struct can keep its name (namespaced).
- **"Stop" the button** vs. **`end()` the napi method** are deliberately mismatched: Stop is a Pause; End is permanent teardown. Local-only product (no users), so the asymmetry is cheap to keep.

## Example dialogue

> **Dev:** "When the user clicks Stop on game 2 of a fearless series and then picks a champion, what happens to the Compute?"
> **Domain expert:** "The Compute pauses, a Snapshot is persisted for that **Navigator Draft**. When the pick lands, a new Navigator Event appears, which triggers a fresh Compute against the same **Navigator Series** key — supersession deletes the paused snapshot for game 2 since its events list is now stale, and a new Compute starts from the post-pick state."

## Evolution scars

- Originally a **Compute** was scoped to one **Draft**. The multi-draft Series concept was layered in later, which is why the in-memory map is keyed by Series id with a `draft` field on the entry, rather than by Navigator Draft id directly.
- **Draft** is shared with Canvas and Versus features, so the Navigator wraps it in **Navigator Draft** to carry navigator-only state without polluting the shared model.
- `entry.stopReason` was renamed `entry.endReason` (2026-06): the three values
  (`user`/`supersede`/`disconnect`) are all End reasons; the prior name implied a
  Pause/Stop binding it never had. ADR-0001 line 3 and ADR-0003 row 1 updated
  in the same change.
