import type { GameType } from "@draft-sim/shared-types";

/**
 * Default classification for a group being CREATED in the settings dialog.
 *
 * A fresh custom group is a scratch pad, so it starts as `scratch`. A series
 * created in the same dialog is a real match though — and search hides every
 * scratch group under the default scope (see countsInScope), so a series left
 * on `scratch` has its linked team silently missing from the team dropdown.
 * Mirror D6 (an untagged series counts as a scrim) and start it as `scrim`.
 *
 * Only ever applied while the user has not touched the field themselves.
 */
export const defaultNewGroupGameType = (seriesEnabled: boolean): GameType =>
    seriesEnabled ? "scrim" : "scratch";
