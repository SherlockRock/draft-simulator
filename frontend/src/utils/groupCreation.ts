import type { DraftMode, GameType, CanvasGroupMetadataUpdate } from "./schemas";
import {
    DEFAULT_GRID_COLS,
    DEFAULT_GRID_ROWS,
    buildGridMetadata,
    gridDimensions,
    type GridSettingsInput
} from "./gridLayout";
import { gridContentHeightForRows } from "./gridRows";
import type { CardLayout } from "./canvasCardLayout";

/**
 * What a NEW Group is born as (design §10, decisions confirmed 2026-08-10).
 *
 * Pure on purpose: `Canvas.tsx` has no component harness, so every creation
 * default that used to be a literal inside the dialog or a mutation call lives
 * here instead, where it is testable without rendering anything.
 */

/**
 * The draft mode a new SERIES opens at.
 *
 * ⚠️ SERIES ONLY, and new ones at that. Draft mode is not offered for custom
 * groups at all — `resolveNewGroupMetadata` writes no `draftMode` for one, so a
 * new custom group never silently restricts champions across its drafts. And
 * `Canvas.tsx`'s `toDraftMode` falls back to `standard` for anything
 * unrecognised on the EDIT path, which is shared with every existing Group; a
 * legacy series with no stored `draftMode` must keep reading as `standard`.
 */
export const NEW_GROUP_DRAFT_MODE: DraftMode = "fearless";

/**
 * The grid form a new Group starts from — decision 13's `grid` default, which
 * is only observable the moment the user turns Enable Series OFF.
 *
 * A fresh object per call: the dialog seeds mutable signals from it.
 */
export const newGroupGridSettings = (): GridSettingsInput => ({
    gridCols: DEFAULT_GRID_COLS,
    gridRows: DEFAULT_GRID_ROWS,
    rowLabels: [],
    colLabels: []
});

/**
 * The metadata a newly created Group is written with, resolved in the order
 * the dialog decides it: type -> layout -> gridCols/gridRows.
 *
 * A SERIES gets NO grid keys. Its interior is computed from its length (§5.1)
 * rather than laid out by a container grid, and stamping `layout: "grid"` on
 * one would hand its games to the grid placement paths.
 *
 * A CUSTOM group gets NO `draftMode`. The setting exists and works for custom
 * groups — `draftRestrictions` runs them SYMMETRICALLY, and the backend gate
 * reads the same key — which is exactly why a default must not leak in: every
 * new group would silently restrict champions across its drafts.
 *
 * `gameType: null` (the user picked Untagged) omits the key rather than
 * sending a null: the D3 clear protocol exists to delete a STORED value, and a
 * create has nothing stored yet.
 *
 * A NULL `grid` is the dialog's "Grid layout off", and it produces a FREE
 * group. That null used to be defaulted back to `newGroupGridSettings()` at the
 * call site, so every custom group was born `layout: "grid"` however the toggle
 * was set — the toggle did nothing. `layout: "free"` is written explicitly
 * rather than omitted, matching `resolveLayoutChange`'s clear on the edit path;
 * omitting it would rely on `isGridGroup`'s absent-means-free reading, which is
 * a legacy default rather than a statement of intent.
 */
export const resolveNewGroupMetadata = (input: {
    isSeries: boolean;
    disabledChampions: string[];
    draftMode: DraftMode;
    gameType: GameType | null;
    grid: GridSettingsInput | null;
}): CanvasGroupMetadataUpdate => ({
    disabledChampions: [...input.disabledChampions],
    ...(input.isSeries ? { draftMode: input.draftMode } : {}),
    ...(input.gameType !== null ? { gameType: input.gameType } : {}),
    // `buildGridMetadata` over an empty `existing`, rather than a literal, so
    // the label trimming and column padding are the same code the grid
    // settings save already runs and is tested for.
    ...(input.isSeries
        ? {}
        : input.grid
          ? buildGridMetadata({}, input.grid)
          : { layout: "free" })
});

/**
 * The size a Group is created at.
 *
 * A grid container is born at the size its configured rows and columns need,
 * so a 3x4 grid opens as a 3x4 grid rather than as the header-and-padding
 * sliver an empty grid's content bounds describe. Both terms come from the
 * same functions the live sizing paths use — `gridDimensions` for the width and
 * `gridContentHeightForRows` for the height — so a container's size at birth
 * and after its first drop are produced by one rule, not two.
 *
 * A series or a free-layout Group gets `null`: the caller falls back to the
 * server's own defaults, which is what those two have always used. Free layout
 * is a null `grid` — the same signal `resolveNewGroupMetadata` reads — so the
 * two cannot disagree about what was created.
 */
export const newGroupDimensions = (input: {
    isSeries: boolean;
    grid: GridSettingsInput | null;
    layout: CardLayout;
}): { width: number; height: number } | null => {
    if (input.isSeries || !input.grid) return null;
    // No members yet, so the occupied-row list is empty and the height is
    // entirely the configured floor.
    const height = gridContentHeightForRows([], input.grid.gridRows, input.layout);
    return {
        width: gridDimensions(height, input.grid.gridCols, input.layout).width,
        height
    };
};
