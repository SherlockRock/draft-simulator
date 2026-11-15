import { describe, expect, it } from "vitest";
import type { LeagueImport } from "@draft-sim/shared-types";
import {
    groupSettingsMetadata,
    groupSettingsUpdateBody,
    isImportedSeriesEdit,
    type GroupSettingsSaveData,
    type SettingsEditedGroup
} from "./groupSettingsSave";

// S3 D9: an imported series' settings save carries only name, game type and
// disabled champions; manual series and custom groups keep their old body.

const LEAGUE_IMPORT: LeagueImport = {
    leagueSeriesId: "ls-1",
    tournamentId: "tour-1",
    stageName: "Regular Season",
    startsAt: "2026-11-11T18:00:00Z",
    status: "finished",
    complete: true,
    esclubUrl: "https://esclub.gg/multimedia/serie/00000000-0000-0000-0000-000000000001"
};

const data = (overrides: Partial<GroupSettingsSaveData> = {}): GroupSettingsSaveData => ({
    name: "Week 3",
    disabledChampions: ["Ahri"],
    draftMode: "fearless",
    convertToSeries: false,
    blueTeamName: "Team A",
    redTeamName: "Team B",
    team1_id: "team-1",
    team2_id: "team-2",
    length: 3,
    gameType: "scrim",
    ...overrides
});

const imported: SettingsEditedGroup = {
    type: "series",
    metadata: { origin: "manual" },
    LeagueImport: LEAGUE_IMPORT
};
const manual: SettingsEditedGroup = {
    type: "series",
    metadata: { origin: "manual" },
    LeagueImport: null
};
const live: SettingsEditedGroup = { type: "series", metadata: { origin: "live" } };
const custom: SettingsEditedGroup = { type: "custom", metadata: {} };

describe("isImportedSeriesEdit", () => {
    it("is true only for a series with a LeagueImport that isn't being converted", () => {
        expect(isImportedSeriesEdit(imported, false)).toBe(true);
        expect(isImportedSeriesEdit(imported, true)).toBe(false);
        expect(isImportedSeriesEdit(manual, false)).toBe(false);
        expect(isImportedSeriesEdit(custom, false)).toBe(false);
        expect(isImportedSeriesEdit(undefined, false)).toBe(false);
    });
});

describe("groupSettingsMetadata", () => {
    it("leaves the draft mode out for an imported series", () => {
        expect(
            groupSettingsMetadata({
                editing: imported,
                data: data(),
                staysSeries: true,
                layoutDims: null,
                layoutMetadata: null
            })
        ).toEqual({ disabledChampions: ["Ahri"], gameType: "scrim" });
    });

    it("keeps the draft mode on a series and clears it on a custom group", () => {
        expect(
            groupSettingsMetadata({
                editing: manual,
                data: data(),
                staysSeries: true,
                layoutDims: null,
                layoutMetadata: null
            })
        ).toEqual({
            disabledChampions: ["Ahri"],
            gameType: "scrim",
            draftMode: "fearless"
        });
        expect(
            groupSettingsMetadata({
                editing: custom,
                data: data({ gameType: null }),
                staysSeries: false,
                layoutDims: { width: 400, height: 300 },
                layoutMetadata: { layout: "free" }
            })
        ).toEqual({
            disabledChampions: ["Ahri"],
            gameType: null,
            draftMode: null,
            manualWidth: 400,
            manualHeight: 300,
            layout: "free"
        });
    });
});

describe("groupSettingsUpdateBody", () => {
    const body = (editing: SettingsEditedGroup, saved = data()) =>
        groupSettingsUpdateBody({
            editing,
            data: saved,
            metadata: groupSettingsMetadata({
                editing,
                data: saved,
                staysSeries: editing.type === "series",
                layoutDims: null,
                layoutMetadata: null
            }),
            layoutDims: null
        });

    it("sends only name, disabled champions and game type for an imported series", () => {
        const sent = body(imported);
        expect(sent).toEqual({
            name: "Week 3",
            metadata: { disabledChampions: ["Ahri"], gameType: "scrim" }
        });
        expect(sent).not.toHaveProperty("team1_id");
        expect(sent).not.toHaveProperty("team2_id");
        expect(sent.metadata).not.toHaveProperty("length");
        expect(sent.metadata).not.toHaveProperty("seriesType");
        expect(sent.metadata).not.toHaveProperty("draftMode");
        expect(sent.metadata).not.toHaveProperty("blueTeamName");
    });

    it("keeps the manual series body: names, length, series type and team links", () => {
        expect(body(manual)).toEqual({
            name: "Week 3",
            metadata: {
                disabledChampions: ["Ahri"],
                gameType: "scrim",
                draftMode: "fearless",
                blueTeamName: "Team A",
                redTeamName: "Team B",
                length: 3,
                seriesType: "fearless"
            },
            team1_id: "team-1",
            team2_id: "team-2"
        });
    });

    it("keeps the live series and custom group bodies", () => {
        expect(body(live)).toEqual({
            name: "Week 3",
            metadata: {
                disabledChampions: ["Ahri"],
                gameType: "scrim",
                draftMode: "fearless"
            }
        });
        expect(
            groupSettingsUpdateBody({
                editing: custom,
                data: data({ name: "" }),
                metadata: { disabledChampions: [], gameType: null, draftMode: null },
                layoutDims: { width: 500, height: 200 }
            })
        ).toEqual({
            name: undefined,
            metadata: { disabledChampions: [], gameType: null, draftMode: null },
            width: 500,
            height: 200
        });
    });
});
