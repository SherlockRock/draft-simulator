/**
 * The pure half of restoring a canvas export's Group tree (design §9 / plan
 * Track D). `POST /me/import` used to warn "Group structure is not restored by
 * this import yet" and drop it on the floor; this decides what to build, and
 * the route does nothing but execute the plan.
 *
 * It is a separate module because the route is 400 lines of Sequelize inside a
 * transaction and the backend suite has no database — every rule worth pinning
 * (which containers come back, what happens to a Card whose container does not,
 * what a hand-edited cycle does) lives here, where a test is three objects.
 *
 * Two things it deliberately does NOT do:
 *
 *  - **Series containers are not recreated.** A `type: "series"` row is only
 *    half of a series; the other half is the `VersusDraft` it points at, which
 *    this route imports through its own `versusSeriesIds` selection and which
 *    builds its own container. Recreating the row here would leave a
 *    series-shaped Group with no series behind it, and would double up with the
 *    real one whenever both were selected.
 *  - **It never remaps a coordinate for a Group.** A Group's stored position is
 *    absolute at every depth (ADR-0006), so nesting is entirely a matter of
 *    `parent_group_id`. Cards are the opposite — see `rebased` below.
 */

const { MAX_GROUP_DEPTH } = require("./canvasTree");

/**
 * @param {{ name?: string, groups?: Array<object>, drafts?: Array<object> }} importedCanvas
 * @returns {{
 *   groups: Array<{ sourceId: string, name: string, positionX: number, positionY: number,
 *                   width: number|null, height: number|null, metadata: object,
 *                   parentSourceId: string|null }>,
 *   cards: Array<{ sourceId: string, groupSourceId: string|null,
 *                  positionX: number, positionY: number, rebased: boolean }>,
 *   warnings: string[]
 * }}
 */
function planCanvasGroupImport(importedCanvas) {
  const label = importedCanvas.name || "Imported Canvas";
  const allGroups = importedCanvas.groups ?? [];
  const drafts = importedCanvas.drafts ?? [];
  const warnings = [];

  const seriesCount = allGroups.filter((g) => g.type === "series").length;
  const importable = allGroups.filter((g) => g.type !== "series");
  const importableIds = new Set(importable.map((g) => g.id));

  // A parent that is not itself being created — a series container, or an id
  // the export never carried — makes the child top-level rather than an orphan
  // pointing at nothing.
  const parentOf = new Map(
    importable.map((g) => {
      const parent = g.parent_group_id ?? null;
      return [g.id, parent !== null && importableIds.has(parent) ? parent : null];
    }),
  );

  /**
   * Ancestor count, or `null` when the chain repeats — this node sits in or
   * under a cycle. An export is machine-written, but it is a FILE the user can
   * edit and these rows go straight into the table, so this is the only guard
   * between a hand-edited parent id and a canvas that cannot be rendered.
   */
  const depthOf = (id) => {
    const seen = new Set([id]);
    let depth = 0;
    let current = parentOf.get(id) ?? null;
    while (current !== null) {
      if (seen.has(current)) return null;
      seen.add(current);
      depth += 1;
      current = parentOf.get(current) ?? null;
    }
    return depth;
  };

  // Flattening one Group changes every descendant's depth, so this runs to a
  // fixpoint rather than in one pass. Each round strictly reduces the number of
  // parented Groups, so it terminates.
  let cycles = 0;
  let tooDeep = 0;
  let settled = false;
  while (!settled) {
    settled = true;
    for (const group of importable) {
      if (parentOf.get(group.id) === null) continue;
      const depth = depthOf(group.id);
      if (depth === null) {
        cycles += 1;
        parentOf.set(group.id, null);
        settled = false;
      } else if (depth > MAX_GROUP_DEPTH) {
        tooDeep += 1;
        parentOf.set(group.id, null);
        settled = false;
      }
    }
  }

  if (cycles > 0) {
    warnings.push(
      `Canvas "${label}": ${cycles} group${cycles === 1 ? "" : "s"} referenced ${cycles === 1 ? "itself" : "themselves"} through their parents and ${cycles === 1 ? "was" : "were"} restored at the top level.`,
    );
  }
  if (tooDeep > 0) {
    warnings.push(
      `Canvas "${label}": ${tooDeep} group${tooDeep === 1 ? "" : "s"} nested deeper than ${MAX_GROUP_DEPTH} levels and ${tooDeep === 1 ? "was" : "were"} restored at the top level.`,
    );
  }
  if (seriesCount > 0) {
    warnings.push(
      `Canvas "${label}": ${seriesCount} series container${seriesCount === 1 ? "" : "s"} could not be restored as ${seriesCount === 1 ? "a container" : "containers"}. Their games came in as loose cards — import the series itself to rebuild ${seriesCount === 1 ? "it" : "them"}.`,
    );
  }

  const groups = importable.map((group) => ({
    sourceId: group.id,
    name: group.name || "Imported Group",
    positionX: group.positionX,
    positionY: group.positionY,
    width: group.width ?? null,
    height: group.height ?? null,
    metadata: stripUndefined(group.metadata ?? {}),
    parentSourceId: parentOf.get(group.id) ?? null,
  }));

  const originOf = new Map(
    allGroups.map((g) => [g.id, { x: g.positionX ?? 0, y: g.positionY ?? 0 }]),
  );

  const cards = drafts.map((draft) => {
    const containerId = draft.group_id ?? null;

    if (containerId === null || importableIds.has(containerId)) {
      // Either loose already, or its container is coming back at the same
      // absolute position — the container-relative pair still reads correctly.
      return {
        sourceId: draft.id,
        groupSourceId: containerId,
        positionX: draft.positionX,
        positionY: draft.positionY,
        rebased: false,
      };
    }

    // Its container is not being recreated. A grouped Card's stored position is
    // relative to that container (ADR-0006), so the same numbers read as world
    // the moment it lands loose — without this the Card jumps to near the
    // canvas origin, which is the same miss `localDeleteGroup` had.
    const origin = originOf.get(containerId) ?? { x: 0, y: 0 };
    return {
      sourceId: draft.id,
      groupSourceId: null,
      positionX: origin.x + draft.positionX,
      positionY: origin.y + draft.positionY,
      rebased: true,
    };
  });

  return { groups, cards, warnings };
}

/**
 * `gameType` is parsed with `.catch(undefined)`, which leaves the KEY present
 * holding `undefined` (reference: Zod .catch key presence). Spread into a
 * create that would clobber a column default, so it goes before the write.
 */
function stripUndefined(metadata) {
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

module.exports = { planCanvasGroupImport };
