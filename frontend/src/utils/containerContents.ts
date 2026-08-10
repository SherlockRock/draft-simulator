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
 * Both counts are DIRECT children, not the subtree. A container's own emptiness
 * is a statement about what sits in it, and a recursive count would make an
 * outer container claim drafts the user cannot see inside it.
 */
export type ContainerContents = {
    /** Direct child Cards — `canvasTree.childCardsOf`. */
    drafts: number;
    /** Direct child Groups — `canvasTree.childGroupsOf`. */
    groups: number;
};

/** Empty means empty of BOTH kinds — the dashed border and the placeholder. */
export const isContainerEmpty = (contents: ContainerContents): boolean =>
    contents.drafts === 0 && contents.groups === 0;

const plural = (count: number, noun: string) =>
    `${count} ${noun}${count !== 1 ? "s" : ""}`;

/**
 * The header count.
 *
 * The draft half is unconditional so a Card-only container reads exactly as it
 * always did; the group half appears only when there is one, so an ordinary
 * container never grows a "· 0 groups" tail it has no use for.
 */
export const containerContentsLabel = (contents: ContainerContents): string =>
    contents.groups > 0
        ? `${plural(contents.drafts, "draft")} · ${plural(contents.groups, "group")}`
        : plural(contents.drafts, "draft");
