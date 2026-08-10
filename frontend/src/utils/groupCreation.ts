import type { DraftMode, GameType, CanvasGroupMetadataUpdate } from "./schemas";
import {
    DEFAULT_GRID_COLS,
    buildGridMetadata,
    type GridSettingsInput
} from "./gridLayout";

/**
 * What a NEW Group is born as (design §10, decisions confirmed 2026-08-10).
 *
 * Pure on purpose: `Canvas.tsx` has no component harness, so every creation
 * default that used to be a literal inside the dialog or a mutation call lives
 * here instead, where it is testable without rendering anything.
 */

/**
 * The draft mode a new Group's dialog opens at.
 *
 * ⚠️ NEW GROUPS ONLY. `Canvas.tsx`'s `toDraftMode` falls back to `standard` for
 * anything unrecognised and is fed `metadata.draftMode ?? metadata.seriesType`.
 * That fallback is shared with every EXISTING Group, so moving it here would
 * silently reinterpret every stored legacy series that has no `draftMode`.
 * Apply this only on the branch keyed off `pendingGroupSettingsPosition()`.
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
    rowLabels: [],
    colLabels: []
});

/**
 * The metadata a newly created Group is written with, resolved in the order
 * the dialog decides it: type -> layout -> gridCols -> draftMode.
 *
 * A SERIES gets NO grid keys. Its interior is computed from its length (§5.1)
 * rather than laid out by a container grid, and stamping `layout: "grid"` on
 * one would hand its games to the grid placement paths.
 *
 * `gameType: null` (the user picked Untagged) omits the key rather than
 * sending a null: the D3 clear protocol exists to delete a STORED value, and a
 * create has nothing stored yet.
 */
export const resolveNewGroupMetadata = (input: {
    isSeries: boolean;
    disabledChampions: string[];
    draftMode: DraftMode;
    gameType: GameType | null;
    grid: GridSettingsInput;
}): CanvasGroupMetadataUpdate => ({
    disabledChampions: [...input.disabledChampions],
    draftMode: input.draftMode,
    ...(input.gameType !== null ? { gameType: input.gameType } : {}),
    // `buildGridMetadata` over an empty `existing`, rather than a literal, so
    // the label trimming and column padding are the same code the grid
    // settings save already runs and is tested for.
    ...(input.isSeries ? {} : buildGridMetadata({}, input.grid))
});
