/**
 * Panel collapse state for the workflow panel's Group tree (design §9).
 *
 * Decision 8 as amended: panel collapse is per-user, EPHEMERAL view state — the
 * same category as the viewport — and is exempt from "all structural state is
 * shared". Nothing here is persisted or broadcast; it is a plain map so the
 * rule can be tested without a renderer.
 *
 * The map holds only the Groups the user has actually toggled. Everything else
 * falls through to a DEPTH-BASED default: a top-level Group starts expanded, a
 * nested one starts collapsed. That is what keeps a flat canvas looking exactly
 * as it did before the panel had a tree while stopping a deep one from
 * rendering every Card at every depth on load.
 */

export type CollapseChoices = ReadonlyMap<string, boolean>;

export const NO_COLLAPSE_CHOICES: CollapseChoices = new Map();

/** `depth` is the ancestor count: 0 for a top-level Group. */
export const isCollapsedAtDepth = (
    choices: CollapseChoices,
    groupId: string,
    depth: number
): boolean => choices.get(groupId) ?? depth > 0;

/**
 * The choices after the user toggles one Group. Returns a NEW map — the caller
 * holds this in a signal, and mutating in place would not re-render.
 */
export const toggledCollapse = (
    choices: CollapseChoices,
    groupId: string,
    depth: number
): CollapseChoices => {
    const next = new Map(choices);
    next.set(groupId, !isCollapsedAtDepth(choices, groupId, depth));
    return next;
};
