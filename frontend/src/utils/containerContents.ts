/**
 * What a custom container HOLDS, for the three surfaces that used to answer it
 * with the Card count alone.
 *
 * `CustomGroupContainer` derived its dashed border, its header count and its
 * "Drag drafts here" placeholder from `props.drafts.length` — and `props.drafts`
 * is `childCardsOf`, so a container holding two nested Groups and no Cards
 * reported 0 and got all three empty-state treatments at once. Nested Groups
 * paint as world-layer siblings rather than as the container's `children`, so
 * the placeholder showed THROUGH the very Groups whose existence it denied.
 *
 * Annotations are the third direct-child kind. Leaving them out repeats the
 * nested-Group defect for the champion-pool fixture: notes persist correctly
 * but the empty fallback replaces the children that would paint them.
 *
 * All counts are DIRECT children, not the subtree. A container's own emptiness
 * is a statement about what sits in it, and a recursive count would make an
 * outer container claim drafts the user cannot see inside it.
 */
export type ContainerContents = {
    /** Direct child Cards — `canvasTree.childCardsOf`. */
    drafts: number;
    /** Direct child Groups — `canvasTree.childGroupsOf`. */
    groups: number;
    /** Direct child notes — `canvasTree.childAnnotationsOf`. */
    annotations: number;
};

/** Empty means empty of all three kinds — the dashed border and placeholder. */
export const isContainerEmpty = (contents: ContainerContents): boolean =>
    contents.drafts === 0 && contents.groups === 0 && contents.annotations === 0;

const plural = (count: number, noun: string) =>
    `${count} ${noun}${count !== 1 ? "s" : ""}`;

/**
 * The header count.
 *
 * The draft half is unconditional so a Card-only container reads exactly as it
 * always did; the group and note parts appear only when non-zero, so an ordinary
 * container never grows "· 0 groups · 0 notes" tails it has no use for.
 */
export const containerContentsLabel = (contents: ContainerContents): string => {
    const parts = [plural(contents.drafts, "draft")];
    if (contents.groups > 0) parts.push(plural(contents.groups, "group"));
    if (contents.annotations > 0) parts.push(plural(contents.annotations, "note"));
    return parts.join(" · ");
};
