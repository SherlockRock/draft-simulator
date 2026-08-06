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
One αβ search for the *current* **Navigator Draft** within an active **Navigator Series**. Tracked JS-side as an entry in `activeTokens`, keyed by **Navigator Series** id (the entry holds a `CancelToken` + version). At most one Compute per Series. αβ is **one-shot**: a Compute runs to completion (or is cancelled by supersession) and returns a full snapshot — there is no pause/resume lifecycle.
_Avoid_: "Session" or "Navigator Session" — those are the DB Series, not the compute.
_History_: a prior MCTS engine ran each Compute as a streaming iterate thread (`activeSessions`, Active ↔ Paused → Ended). Removed 2026-06 when the navigator moved to αβ one-shot; code preserved in tag `archive/mcts-spike`. A future αβ iterative-deepening streaming surface may reintroduce a streaming Compute lifecycle.

**Stop / Pause / Resume** (REMOVED 2026-06 — dormant reference):
The user-facing Stop button ("halt iteration but keep what you've found") and its internal Pause (`LoopState::Paused`, `meta.persistOnPause: true`, `hasPausedSession` derivation) belonged to the MCTS streaming engine. αβ one-shot has no pause affordance — there is nothing to halt-and-keep. Retained here as the reference design for a possible future αβ iterative-deepening streaming surface; code in tag `archive/mcts-spike`.

**End** (internal):
Teardown of a **Compute** — the `CancelToken` is cancelled and the `activeTokens` entry deleted. Triggered by supersession, socket disconnect, or shutdown. `entry.endReason` ∈ {`user`, `supersede`, `disconnect`}.
_History_: under MCTS, End also exited the iterate thread and deleted the `activeSessions` entry.

**Supersession**:
A new **Compute** replacing a prior in-flight one for the same **Navigator Series** (the prior's `CancelToken` is cancelled).
- _Pick-advance supersession_ — a real **Navigator Event** landed; `events.length` grew. The in-flight Compute is cancelled and a fresh one cold-starts from the new state.
- _Same-event supersession_ — forced branch / pool update changed compute parameters without advancing events. (The case the frontend `after_event_id` gate cannot detect on its own.)
- _Draft-switch supersession_ — user navigates to a different **Navigator Draft** within the same series; same key, different game.
_History_: MCTS also supported warm-restart via napi `applyPick` (ADR-0005) and same-event supersession from an algorithm toggle; both removed with the streaming engine.

### Canvas

**Canvas** (DB: `Canvas`):
A collaborative workspace holding **Drafts** (via `CanvasDraft` placements), groups, and connections. Per-user access via `UserCanvas` with permission levels `view` / `edit` / `admin`.

**Card** (DB: `CanvasDraft`):
One **Draft** placed on one **Canvas**, carrying its position and its display-only team labels.
_Avoid_: "canvas draft" in prose (it is the table name, not the thing on screen); "box" (survives in older handler names like `onBoxMouseDown`).

**Canvas Group** (DB: `CanvasGroup`):
A titled frame on a **Canvas** that contains **Cards** and, when `type` is `custom`, other **Canvas Groups**.
- `custom` — general container; may hold Groups and Cards.
- `series` — **leaf container**, bound to a `VersusDraft`; holds only its game Cards, ordered by `seriesIndex`, and can never contain a Group.

Container capability is exactly `type === 'custom'`; there is no separate nesting type.
_Avoid_: **"Folder"**. See Flagged ambiguities.

**Footprint**:
The integer cell rectangle a node occupies inside a grid **Canvas Group** — `1×1` for a Card, and for anything larger derived from its rendered size (`ceil(w / cellWidth) × ceil(h / cellHeight)`). One rule, no per-type special case: series chrome and grid chrome use different constants, so an N-game Series is `2 × (N+1)` cells, never `1×N`.

**Game Type** (`CanvasGroup.metadata.gameType`):
What a **Canvas Group**'s games are — `scrim` / `official` / `scratch`, or absent meaning untagged. Decides whether its Cards count toward a Team's canvas record. Resolution stops at a Card's *immediate* Group and never walks ancestors.
_Avoid_: "competitive" for this concept — `VersusDraft.competitive` is the adjacent but distinct ruleset-lockdown flag.

**Canvas Mutation Gate** (planned module, design settled 2026-07-01):
The single seam for "may this actor change this Canvas-related thing, and apply it if so." Two mutation classes behind one interface:
- _Persisted mutations_ (picks, rename, positions-at-drag-end, group settings) — run the full pipeline: authorize → validate (lock, disabled champions, series restrictions) → persist → broadcast.
- _Ephemeral relays_ (drag previews: object/vertex/group move, group resize) — authorize → broadcast only; persistence arrives later via a persisted mutation.

The gate **emits via an injected emitter** (owns room targeting and event vocabulary) and **throws uniform typed errors** (`NotAuthorized`, `DraftLocked`, `ChampionRestricted`, …); adapters translate — REST to status codes, socket to error events. Replaces ~28 inline `userCanvas.permissions` checks across REST routes and socket handlers (strangler migration: socket handlers first).
_Known quirk (kept, documented)_: draft-pick permission is "edit on **any** canvas containing the Draft," and lock is "locked on **any** canvas blocks all." Benign today because cross-canvas shared Drafts are only versus-linked, which are not editable — revisit if that changes.

## Relationships

- One **User** owns many **Navigator Series**.
- One **Navigator Series** has many **Navigator Drafts** (one per `game_number`).
- One **Navigator Draft** wraps one **Draft** (shared model).
- One **Navigator Draft** has many **Navigator Events** and many **Navigator Snapshots**.
- At any moment a Series has *at most one* live **Compute** (in-memory, not in DB).
- A **Compute** is *for* one **Navigator Draft** at a time; switching drafts within a Series supersedes.
- One **Canvas** has many **Cards** and many **Canvas Groups**.
- One **Card** belongs to at most one **Canvas Group** (its immediate container).
- One `custom` **Canvas Group** may contain many **Canvas Groups** and many **Cards**; a `series` Group contains only **Cards**.

## Flagged ambiguities

- **"folder"**: rejected 2026-08-04. The recursive-nesting design used it for "a custom **Canvas Group** that contains child Groups", but every custom Group contains something, so the word distinguished nothing — the design itself called it "a description, not a schema type". It also implies drill-in navigation, which that design explicitly rejects (nesting renders inline as frames on one infinite canvas). Canonical: a **Canvas Group** can contain **Canvas Groups**. The UI already says "Group" throughout ("Create Group", "Drafts & Groups") and does not change.
- **"session"**: overloaded across two layers — (1) `NavigatorSession` DB model = the Series, (2) "sessionId" in socket events / `activeTokens` map = the Series id. Canonical: call the DB row a **Navigator Series**, call the in-memory αβ search a **Compute**. (A third sense, the napi `NavigatorSession` struct, existed under MCTS and was removed 2026-06.)

## Example dialogue

> **Dev:** "When the user picks a champion on game 2 of a fearless series mid-Compute, what happens?"
> **Domain expert:** "A new Navigator Event appears, so `events.length` grows. That supersedes the in-flight Compute for the **Navigator Series** — its `CancelToken` is cancelled — and a fresh αβ Compute cold-starts from the post-pick state, writing a new Snapshot for that **Navigator Draft**."

_(Historical: under the removed MCTS streaming engine, a Stop click would Pause the Compute and persist a paused Snapshot, then a later pick would supersede-and-delete it. αβ one-shot has no pause; see the Stop/Pause dormant-reference entry above.)_

## Evolution scars

- Originally a **Compute** was scoped to one **Draft**. The multi-draft Series concept was layered in later, which is why the in-memory map is keyed by Series id with a `draft` field on the entry, rather than by Navigator Draft id directly.
- **Draft** is shared with Canvas and Versus features, so the Navigator wraps it in **Navigator Draft** to carry navigator-only state without polluting the shared model.
- `entry.stopReason` was renamed `entry.endReason` (2026-06): the three values
  (`user`/`supersede`/`disconnect`) are all End reasons; the prior name implied a
  Pause/Stop binding it never had. ADR-0001 line 3 and ADR-0003 row 1 updated
  in the same change.
- The **MCTS streaming engine was removed 2026-06**; the navigator now runs αβ
  one-shot. The streaming lifecycle (Compute pause/resume, warm-restart, the
  partial-snapshot overlay, the engine toggle) is gone. Its glossary entries
  above are kept as **dormant reference** for a possible future αβ
  iterative-deepening streaming surface; ADRs 0001–0005 are marked superseded
  for the same reason. All removed code is preserved in git tag
  `archive/mcts-spike`. Decision arc: Obsidian `draft-simulator-mcts-spike`.
