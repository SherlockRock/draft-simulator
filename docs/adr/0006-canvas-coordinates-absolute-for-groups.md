# Canvas coordinates stay absolute for Groups, relative for Cards

**Status:** accepted 2026-08-04. Reverses decision 3 of
`docs/designs/recursive-canvas-folders-design.md` (2026-07-08), which had passed
two independent review passes.

**Confirmed 2026-08-05** by two further independent reviews (Codex read-only, and a fresh
Opus agent) that were briefed to falsify it. Both enumerated every coordinate site in
`frontend/src` and neither found a reader that breaks at depth ≥ 2. The consequences
section below was corrected in one place — the cost bound is breadth, not depth.

A **Canvas Group** stores `positionX/Y` in absolute world coordinates **at every
nesting depth**. A **Card** stores `positionX/Y` relative to its immediate
container. This is the model the canvas already had when Groups were flat; nesting
extends it rather than replacing it.

## Why this is worth recording

A reader who finds nested Groups will expect coordinates relative to the parent —
that is the conventional model, it is what nested DOM wants, and it is what this
project's own design document specified for four weeks. There is deliberately **no
geometry index and no `worldRectOf` accumulation helper**, and someone will
eventually try to add one. This ADR is why they shouldn't have to.

## Considered options

**Relative-to-parent coordinates + a memoized geometry index** (the original
decision 3). Rendering, connections and hit-testing would read the index; raw
`positionX/Y` would become local-only and never a world coordinate.

It was chosen on the argument that dragging a container writes *O(direct children)*
rows rather than *O(subtree)*. That comparison was against absolute coordinates for
**everything, Cards included** — a model this codebase has never had. Measured
against what actually exists, the real cost of a container drag under absolute
Group coordinates is *O(descendant **Groups**)*: Cards ride along untouched,
because their coordinates are relative to a container that moved with them. At the
design's own stated scale ("few folders, 1–2 levels") that is single-digit rows.

The price of the index, re-derived from current code on 2026-08-04, was **~30
world-coordinate resolution sites across 5 files** — `Canvas.tsx` (~15),
`CanvasWorkflow.tsx` (~7), `helpers.ts` (3), `Connections.tsx` (2),
`copyPlacement.ts` (3). The design estimated ~9 across ≥4 files and scheduled the
migration as its highest-risk slice. It was the single largest chunk of work in the
feature.

(Counted as *resolution* sites — reads that treat a stored coordinate as world, or
accumulate one level. Sites that merely *compute* a world position to write, such as
`CanvasDetailView.tsx`, are excluded: they are unaffected either way.)

## Consequences

- **No geometry index, no per-ancestor-chain memo.** Decision 3.1d of that design
  is void.
- **All ~30 existing sites stay correct at any depth, unchanged.** They read
  `group.positionX` as world and accumulate one level for a Card — which is exactly
  right under this model.
- **Reparenting writes no coordinates.** A Group's world position is unchanged by
  gaining a new parent; only `parent_group_id` moves.
- **Deleting a container and promoting its children rebases nothing**, for the same
  reason.
- **Float drift on rebase cannot occur**, because there is no rebase. The design's
  open question 11.4 (a rounding/epsilon rule for free-layout containers) is void.
- **Connection `vertices` stop being an exception.** They are stored in world space;
  under this model so is everything else.
- **A container drag must write every descendant Group row** on commit. This is the bill
  for the above. **The cost is bounded by BREADTH, which nothing caps — not by the depth
  cap** (corrected 2026-08-05; the original text said the depth cap bounds it, which is
  the wrong dimension). The motivating artifact is one container holding a season of
  series groups: depth 1, breadth 20–40.
  Mitigated by sending the container's **absolute target position** and having the server
  **derive** `(dx, dy)` against the locked row, then fan that out over the subtree inside
  the transaction. That keeps the payload and the live socket event O(1), makes concurrent
  subtree moves commutative instead of destructive, and keeps rollback and undo single
  operations — while staying idempotent and drop-tolerant, which a delta on the wire is
  not. See the design's §8 and 3.1c.
- **The duplication is not cleaned up.** ~30 one-level accumulations remain
  scattered. They are correct, merely repetitive — a far smaller problem than the
  design feared, and a `worldRectOf` convenience can be added to `canvasTree.ts`
  later and adopted opportunistically, but it must never become mandatory
  infrastructure that raw reads are forbidden to bypass.

## What this does not change

`canvasTree.ts` is still built and still mandatory as the sole union point for
heterogeneous children — `childrenOf`, `ancestorsOf`, `depthOf`, `isDescendant`,
`gridItemsOf`. Cycle guards, the depth cap, deepest-first hit-testing and the
render depth-sort all need it. It is ~150 lines of pure functions in the
`utils/viewport.ts` house style, not a 30-site migration.
