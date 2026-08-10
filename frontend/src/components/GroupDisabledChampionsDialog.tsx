import { createSignal, createEffect, createMemo, Show, Component } from "solid-js";
import { ChevronDown, ChevronUp } from "lucide-solid";
import type { DraftMode, GameType, Team } from "@draft-sim/shared-types";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";
import { ChampionToggleGrid } from "./ChampionToggleGrid";
import { StyledSelect } from "./StyledSelect";
import { TeamNameSelect } from "./TeamNameSelect";
import { GridSettingsFields, createGridSettingsForm } from "./GridSettingsFields";
import { resolveChampionId } from "../utils/constants";
import { resolveTeamLink } from "../utils/teamLink";
import { gameTypeHint } from "../utils/gameClassification";
import { newGroupGridSettings } from "../utils/groupCreation";
import type { GridSettingsInput } from "../utils/gridLayout";

interface GroupSettingsDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    initialName: string;
    initialChampions: string[];
    initialDraftMode: DraftMode;
    isSeries?: boolean;
    canEditSeriesSettings?: boolean;
    initialBlueTeamName?: string;
    initialRedTeamName?: string;
    initialTeam1Id?: string | null;
    initialTeam2Id?: string | null;
    initialLength?: number;
    /** Absent = untagged. */
    initialGameType?: GameType;
    /**
     * True while the dialog is creating a group rather than editing one. New
     * groups default to Scratch: most are made to try something out, and an
     * explicit "not a real game" is a better starting point than a value that
     * silently counts. Note this DOES change behaviour for new manual series —
     * they used to count via D6's untagged-series fallback and now do not,
     * until the user classifies them.
     */
    isNewGroup?: boolean;
    defaultSeriesEnabled?: boolean;
    primaryLabel?: string;
    /** The user's owned teams for autocomplete linking. */
    teams?: Team[];
    /** Enable entity linking; false on local/anonymous canvases. */
    teamsEnabled?: boolean;
    onTeamCreated?: (team: Team) => void;
    onSave: (data: {
        name: string;
        disabledChampions: string[];
        draftMode: DraftMode;
        convertToSeries: boolean;
        blueTeamName: string;
        redTeamName: string;
        team1_id: string | null;
        team2_id: string | null;
        length: number;
        /** null clears a stored classification; see the clear protocol (D3). */
        gameType: GameType | null;
        /**
         * Columns and labels for a new CUSTOM Group, which is born `grid`
         * (decision 13). `null` whenever the grid fields were not on screen —
         * editing an existing Group, or creating a series, whose interior is
         * computed rather than laid out by a container grid.
         */
        grid: GridSettingsInput | null;
    }) => void;
}

const DRAFT_MODE_OPTIONS = [
    { value: "standard", label: "Standard" },
    { value: "fearless", label: "Fearless" },
    { value: "ironman", label: "Ironman" }
];

/** "" is Untagged; it emits null so the backend deletes the stored key (D3). */
const GAME_TYPE_OPTIONS = [
    { value: "", label: "Untagged" },
    { value: "scrim", label: "Scrim" },
    { value: "official", label: "Official" },
    { value: "scratch", label: "Scratch" }
];

const parseGameType = (value: string): GameType | null =>
    value === "scrim" || value === "official" || value === "scratch" ? value : null;

const SERIES_LENGTH_OPTIONS = [
    { value: "1", label: "1 game" },
    { value: "2", label: "2 games" },
    { value: "3", label: "3 games" },
    { value: "4", label: "4 games" },
    { value: "5", label: "5 games" },
    { value: "6", label: "6 games" },
    { value: "7", label: "7 games" }
];

const clampSeriesLength = (value: number) => {
    if (!Number.isFinite(value)) return 3;
    return Math.min(7, Math.max(1, Math.trunc(value)));
};

export const GroupSettingsDialog: Component<GroupSettingsDialogProps> = (props) => {
    const [name, setName] = createSignal("");
    const [selected, setSelected] = createSignal<string[]>([]);
    const [draftMode, setDraftMode] = createSignal<DraftMode>("standard");
    const [seriesEnabled, setSeriesEnabled] = createSignal(false);
    const [blueTeamName, setBlueTeamName] = createSignal("Team 1");
    const [redTeamName, setRedTeamName] = createSignal("Team 2");
    const [team1Id, setTeam1Id] = createSignal<string | null>(null);
    const [team2Id, setTeam2Id] = createSignal<string | null>(null);
    const [length, setLength] = createSignal(3);
    const [gameType, setGameType] = createSignal<GameType | null>(null);
    const [disabledExpanded, setDisabledExpanded] = createSignal(false);
    const gridForm = createGridSettingsForm();

    /**
     * Grid configuration is offered at CREATION only, and only once the user
     * has said this is not a series — that is the one moment decision 13's
     * `grid` default is observable. An existing Group edits its grid through
     * the context menu's "Grid settings…", which stays the single place to
     * change columns after the fact.
     */
    const showGrid = createMemo(() => (props.isNewGroup ?? false) && !seriesEnabled());

    // A brand-new Group has no members, so a reflow produces exactly one row.
    // Row labels beyond it become reachable once it holds something.
    const gridRowInputCount = createMemo(() => Math.max(1, gridForm.rowLabels().length));

    createEffect(() => {
        if (props.isOpen()) {
            setName(props.initialName);
            setSelected(props.initialChampions.map(resolveChampionId));
            setDraftMode(props.initialDraftMode);
            setSeriesEnabled(
                (props.isSeries ?? false) || (props.defaultSeriesEnabled ?? false)
            );
            setBlueTeamName(props.initialBlueTeamName || "Team 1");
            setRedTeamName(props.initialRedTeamName || "Team 2");
            setTeam1Id(props.initialTeam1Id ?? null);
            setTeam2Id(props.initialTeam2Id ?? null);
            setLength(clampSeriesLength(props.initialLength || 3));
            setGameType(props.initialGameType ?? (props.isNewGroup ? "scratch" : null));
            setDisabledExpanded(false);
            gridForm.seed(newGroupGridSettings());
        }
    });

    const save = () => {
        // A name typed without picking the dropdown row still links, as long as
        // it unambiguously names one of your teams — see resolveTeamLink. Gated
        // on teamsEnabled so a cached ["teams"] list can never link on a surface
        // that renders the field as plain text (local/anonymous canvases).
        const teams = props.teamsEnabled ? (props.teams ?? []) : [];
        const blue = resolveTeamLink(blueTeamName(), team1Id(), teams, "Team 1");
        const red = resolveTeamLink(redTeamName(), team2Id(), teams, "Team 2");
        props.onSave({
            name: name().trim(),
            disabledChampions: selected(),
            draftMode: draftMode(),
            convertToSeries: !props.isSeries && seriesEnabled(),
            blueTeamName: blue.name,
            redTeamName: red.name,
            team1_id: blue.teamId,
            team2_id: red.teamId,
            length: clampSeriesLength(length()),
            gameType: gameType(),
            grid: showGrid() ? gridForm.read(gridRowInputCount()) : null
        });
        props.onClose();
    };

    const handleToggle = (champId: string) => {
        setSelected((prev) =>
            prev.includes(champId)
                ? prev.filter((id) => id !== champId)
                : [...prev, champId]
        );
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            onConfirm={save}
            confirmOnInput={true}
            body={
                <div class="w-[min(100vw-2rem,32rem)] max-w-full">
                    <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                        {props.isNewGroup ? "New Group" : "Group Settings"}
                    </h2>

                    <div class="space-y-4">
                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Group Name
                            <input
                                type="text"
                                value={name()}
                                onInput={(e) => setName(e.currentTarget.value)}
                                class="mt-2 w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                            />
                        </label>

                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Draft Mode
                            <div class="mt-2">
                                <StyledSelect
                                    value={draftMode()}
                                    onChange={(v) => {
                                        if (
                                            v === "standard" ||
                                            v === "fearless" ||
                                            v === "ironman"
                                        ) {
                                            setDraftMode(v);
                                        }
                                    }}
                                    options={DRAFT_MODE_OPTIONS}
                                    theme="purple"
                                />
                            </div>
                        </label>
                        <div class="-mt-2 min-h-[2.5rem] text-xs text-darius-text-secondary">
                            <Show when={draftMode() === "fearless"}>
                                <p>
                                    Champions picked in one draft cannot be picked in
                                    other drafts within this group.
                                </p>
                            </Show>
                            <Show when={draftMode() === "ironman"}>
                                <p>
                                    Champions picked or banned in one draft cannot be used
                                    in other drafts within this group.
                                </p>
                            </Show>
                        </div>

                        {/*
                          Deliberately outside BOTH the seriesEnabled() and the
                          canEditSeriesSettings conditions below. Gating on
                          canEditSeriesSettings would hide it for live-imported
                          series, which D2 exists to make correctable; gating on
                          seriesEnabled() would hide it for custom groups, which
                          is the entire point of tagging one so it counts.
                        */}
                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Game Type
                            <div class="mt-2">
                                <StyledSelect
                                    value={gameType() ?? ""}
                                    onChange={(v) => setGameType(parseGameType(v))}
                                    options={GAME_TYPE_OPTIONS}
                                    theme="purple"
                                />
                            </div>
                        </label>
                        <p class="-mt-2 min-h-[2rem] text-xs text-darius-text-secondary">
                            {gameTypeHint(
                                gameType(),
                                (props.isSeries ?? false) || seriesEnabled()
                            )}
                        </p>

                        <Show when={!props.isSeries}>
                            <label class="flex cursor-pointer items-start justify-between gap-4 rounded-md border border-darius-border bg-darius-card-hover/40 px-3 py-3 transition-colors hover:border-darius-purple-bright/60">
                                <div class="min-w-0">
                                    <div class="text-sm font-medium text-darius-text-primary">
                                        Enable Series
                                    </div>
                                    <p class="mt-1 text-xs text-darius-text-secondary">
                                        Add manual team names and a best-of length.
                                    </p>
                                </div>
                                <div class="relative mt-0.5 shrink-0">
                                    <input
                                        type="checkbox"
                                        checked={seriesEnabled()}
                                        onChange={(e) =>
                                            setSeriesEnabled(e.currentTarget.checked)
                                        }
                                        class="peer sr-only"
                                    />
                                    <span class="block h-6 w-11 rounded-full bg-darius-border transition-colors peer-checked:bg-darius-purple" />
                                    <span class="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                                </div>
                            </label>
                        </Show>

                        <Show
                            when={
                                seriesEnabled() && (props.canEditSeriesSettings ?? true)
                            }
                        >
                            <div class="space-y-4 rounded-md border border-darius-border bg-darius-card-hover/30 p-3">
                                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <label class="block text-sm font-medium text-darius-text-secondary">
                                        Blue Team Name
                                        <div class="mt-2">
                                            <TeamNameSelect
                                                value={blueTeamName()}
                                                teamId={team1Id()}
                                                teams={props.teams ?? []}
                                                disabled={!(props.teamsEnabled ?? false)}
                                                onChange={(nextName, nextId) => {
                                                    setBlueTeamName(nextName);
                                                    setTeam1Id(nextId);
                                                }}
                                                onCreated={props.onTeamCreated}
                                            />
                                        </div>
                                    </label>
                                    <label class="block text-sm font-medium text-darius-text-secondary">
                                        Red Team Name
                                        <div class="mt-2">
                                            <TeamNameSelect
                                                value={redTeamName()}
                                                teamId={team2Id()}
                                                teams={props.teams ?? []}
                                                disabled={!(props.teamsEnabled ?? false)}
                                                onChange={(nextName, nextId) => {
                                                    setRedTeamName(nextName);
                                                    setTeam2Id(nextId);
                                                }}
                                                onCreated={props.onTeamCreated}
                                            />
                                        </div>
                                    </label>
                                </div>
                                <div class="grid grid-cols-1 gap-3 sm:max-w-[14rem]">
                                    <label class="block text-sm font-medium text-darius-text-secondary">
                                        Series Length
                                        <div class="mt-2">
                                            <StyledSelect
                                                value={String(length())}
                                                onChange={(value) =>
                                                    setLength(Number(value))
                                                }
                                                options={SERIES_LENGTH_OPTIONS}
                                                theme="purple"
                                            />
                                        </div>
                                    </label>
                                </div>
                            </div>
                        </Show>

                        {/*
                          The complement of the series box above. Turning
                          Enable Series OFF is the only moment decision 13's
                          `grid` default is observable, so the columns it
                          implies are editable right there rather than behind a
                          second trip through the context menu.
                        */}
                        <Show when={showGrid()}>
                            <div class="space-y-3 rounded-md border border-darius-border bg-darius-card-hover/30 p-3">
                                <div>
                                    <div class="text-sm font-medium text-darius-text-primary">
                                        Grid layout
                                    </div>
                                    <p class="mt-1 text-xs text-darius-text-secondary">
                                        Drafts dropped into this group snap to a grid.
                                        Change it later from the group menu.
                                    </p>
                                </div>
                                <GridSettingsFields
                                    form={gridForm}
                                    rowInputCount={gridRowInputCount}
                                    idPrefix="new-group-grid"
                                />
                            </div>
                        </Show>

                        <div class="rounded-md border border-darius-border bg-darius-card-hover/50">
                            <button
                                type="button"
                                onClick={() => setDisabledExpanded(!disabledExpanded())}
                                class="flex w-full items-center justify-between px-3 py-2 text-sm text-darius-text-secondary transition-colors hover:text-darius-text-primary"
                            >
                                <span>
                                    Disabled Champions{" "}
                                    <span class="text-darius-text-secondary">
                                        (
                                        {selected().length > 0
                                            ? `${selected().length} disabled`
                                            : "None"}
                                        )
                                    </span>
                                </span>
                                <Show
                                    when={disabledExpanded()}
                                    fallback={<ChevronDown size={16} />}
                                >
                                    <ChevronUp size={16} />
                                </Show>
                            </button>
                            <Show when={disabledExpanded()}>
                                <div class="border-t border-darius-border px-3 pb-3 pt-2">
                                    <ChampionToggleGrid
                                        selectedChampions={selected}
                                        onToggle={handleToggle}
                                        theme="purple"
                                    />
                                </div>
                            </Show>
                        </div>
                    </div>

                    <div class="mt-4 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={() => {
                                (document.activeElement as HTMLElement)?.blur();
                                props.onClose();
                            }}
                            class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                        >
                            <span>Cancel</span>
                            <EscapeKeyHint />
                        </button>
                        <button
                            type="button"
                            onClick={save}
                            class="flex items-center gap-2 rounded-md bg-darius-purple px-4 py-2 text-sm font-medium text-white"
                        >
                            <span>{props.primaryLabel ?? "Save"}</span>
                            <ReturnKeyHint />
                        </button>
                    </div>
                </div>
            }
        />
    );
};
