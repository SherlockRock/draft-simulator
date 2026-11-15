import type {
    CanvasGroup,
    CanvasGroupMetadataUpdate,
    DraftMode,
    GameType
} from "@draft-sim/shared-types";

/** What the group settings dialog saves (`handleSaveGroupSettings`). */
export type GroupSettingsSaveData = {
    name: string;
    disabledChampions: string[];
    draftMode: DraftMode;
    convertToSeries: boolean;
    blueTeamName: string;
    redTeamName: string;
    team1_id: string | null;
    team2_id: string | null;
    length: number;
    gameType: GameType | null;
};

/** The parts of the edited group that decide the save's shape. */
export type SettingsEditedGroup = {
    type: CanvasGroup["type"];
    metadata: Pick<CanvasGroup["metadata"], "origin">;
    LeagueImport?: CanvasGroup["LeagueImport"];
};

type LayoutDims = { width: number; height: number };

/**
 * S3 D9: esclub owns an imported series' teams, names, length and draft mode
 * (the server refuses a change), so its save leaves them out entirely.
 */
export function isImportedSeriesEdit(
    editing: SettingsEditedGroup | undefined,
    convertToSeries: boolean
): boolean {
    return !convertToSeries && editing?.type === "series" && !!editing.LeagueImport;
}

/**
 * The metadata every save path writes (local and server). Draft mode is a
 * SERIES setting: a custom group's save CLEARS it (`null`, the D3 clear
 * protocol); an imported series' save leaves it out. The manual size floor
 * rides with a count change, and so does the layout's own metadata.
 */
export function groupSettingsMetadata(input: {
    editing: SettingsEditedGroup | undefined;
    data: GroupSettingsSaveData;
    staysSeries: boolean;
    layoutDims: LayoutDims | null;
    layoutMetadata: CanvasGroupMetadataUpdate | null;
}): CanvasGroupMetadataUpdate {
    const { data } = input;
    return {
        disabledChampions: data.disabledChampions,
        gameType: data.gameType,
        ...(isImportedSeriesEdit(input.editing, data.convertToSeries)
            ? {}
            : { draftMode: input.staysSeries ? data.draftMode : null }),
        ...(input.layoutDims
            ? {
                  manualWidth: input.layoutDims.width,
                  manualHeight: input.layoutDims.height
              }
            : {}),
        ...(input.layoutMetadata ?? {})
    };
}

/**
 * The body of the server's group update for a settings save (not a
 * conversion), without the canvas and group ids. Only a manual series that
 * isn't imported carries team names, length, series type and team links.
 */
export function groupSettingsUpdateBody(input: {
    editing: SettingsEditedGroup | undefined;
    data: GroupSettingsSaveData;
    metadata: CanvasGroupMetadataUpdate;
    layoutDims: LayoutDims | null;
}): {
    name: string | undefined;
    metadata: CanvasGroupMetadataUpdate;
    width?: number;
    height?: number;
    team1_id?: string | null;
    team2_id?: string | null;
} {
    const { editing, data } = input;
    const isManualSeries =
        editing?.type === "series" &&
        editing.metadata.origin === "manual" &&
        !isImportedSeriesEdit(editing, data.convertToSeries);
    return {
        name: data.name || undefined,
        metadata: {
            ...input.metadata,
            ...(isManualSeries
                ? {
                      blueTeamName: data.blueTeamName,
                      redTeamName: data.redTeamName,
                      length: data.length,
                      seriesType: data.draftMode
                  }
                : {})
        },
        ...(input.layoutDims
            ? { width: input.layoutDims.width, height: input.layoutDims.height }
            : {}),
        // Team linking persists on manual series groups only.
        ...(isManualSeries ? { team1_id: data.team1_id, team2_id: data.team2_id } : {})
    };
}
