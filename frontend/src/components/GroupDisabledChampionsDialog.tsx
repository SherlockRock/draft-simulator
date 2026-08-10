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
    /** The group's stored layout; a new Group has none and defaults to grid. */
    initialLayout?: "free" | "grid";
    /** The group's stored grid config, seeded into the form when editing. */
    initialGrid?: {
        gridCols?: number;
        gridRows?: number;
        rowLabels?: string[];
        colLabels?: string[];
    };
    /**
     * How many rows this container's CONTENT occupies at a given column count —
     * `arrangedRowCount`, supplied by Canvas because it needs the tree. Row
     * inputs are offered for at least this many, so a grid that already spills
     * past its configured row count can still label those rows. A new Group has
     * no content and omits it.
     */
    contentRowCount?: (cols: number) => number;
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
         * The grid this CUSTOM Group should have, or `null` for free layout.
         *
         * Ignored for a series, whose interior is computed from its length
         * (§5.1) rather than laid out by a container grid — the grid section is
         * not rendered at all in that case, so `null` there means "not
         * applicable" rather than "convert to free".
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
    const [gridEnabled, setGridEnabled] = createSignal(false);
    const gridForm = createGridSettingsForm();

    /**
     * This dialog owns layout for every custom Group, creating or editing —
     * there is no separate grid dialog and no grid entry in the group context
     * menu. A series is excluded because its interior is computed from its
     * length (§5.1) rather than laid out by a container grid.
     */
    const showLayout = createMemo(() => !(props.isSeries ?? false) && !seriesEnabled());

    /**
     * Draft mode is a SERIES setting only.
     *
     * It does function on custom groups — `draftRestrictions` runs those
     * symmetrically and the backend gate reads the same key — which is exactly
     * why it is not offered for one: a custom group is a container, and a
     * container silently restricting champions across everything inside it is
     * not what anyone means by dropping drafts into a folder. Saving a custom
     * group CLEARS any stored mode (see Canvas's save handler).
     */
    const showDraftMode = createMemo(() => (props.isSeries ?? false) || seriesEnabled());

    // At least the configured rows, at least what the content already occupies,
    // and at least as many as there are stored labels — otherwise `mergeLabels`
    // silently trims the labels beyond the visible inputs.
    const gridRowInputCount = createMemo(() =>
        Math.max(
            gridForm.rows(),
            props.contentRowCount?.(gridForm.cols()) ?? 0,
            gridForm.rowLabels().length,
            1
        )
    );

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
            // Decision 13: a new custom Group is a grid. An existing one keeps
            // whatever it stored, `free` being the legacy default.
            setGridEnabled(
                props.isNewGroup ? true : (props.initialLayout ?? "free") === "grid"
            );
            gridForm.seed(props.initialGrid ?? newGroupGridSettings());
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
            grid:
                showLayout() && gridEnabled() ? gridForm.read(gridRowInputCount()) : null
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

                        {/*
                          Deliberately OUTSIDE canEditSeriesSettings, like Game
                          Type: gating on it would hide draft mode for a
                          live-imported series, which is exactly the series most
                          likely to need it corrected.
                        */}
                        <Show when={showDraftMode()}>
                            <div>
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
                                <div class="min-h-[2.5rem] text-xs text-darius-text-secondary">
                                    <Show when={draftMode() === "fearless"}>
                                        <p>
                                            Champions picked in one draft cannot be picked
                                            in other drafts within this series.
                                        </p>
                                    </Show>
                                    <Show when={draftMode() === "ironman"}>
                                        <p>
                                            Champions picked or banned in one draft cannot
                                            be used in other drafts within this series.
                                        </p>
                                    </Show>
                                </div>
                            </div>
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
                          The complement of the series box above, and the ONE
                          place a Group's layout is set — creating or editing.
                          There is no separate grid dialog and no grid entry in
                          the group context menu.
                        */}
                        <Show when={showLayout()}>
                            <label class="flex cursor-pointer items-start justify-between gap-4 rounded-md border border-darius-border bg-darius-card-hover/40 px-3 py-3 transition-colors hover:border-darius-purple-bright/60">
                                <div class="min-w-0">
                                    <div class="text-sm font-medium text-darius-text-primary">
                                        Grid layout
                                    </div>
                                    <p class="mt-1 text-xs text-darius-text-secondary">
                                        Drafts snap to rows and columns. Off, they sit
                                        wherever you drop them.
                                    </p>
                                </div>
                                <div class="relative mt-0.5 shrink-0">
                                    <input
                                        type="checkbox"
                                        checked={gridEnabled()}
                                        onChange={(e) =>
                                            setGridEnabled(e.currentTarget.checked)
                                        }
                                        class="peer sr-only"
                                    />
                                    <span class="block h-6 w-11 rounded-full bg-darius-border transition-colors peer-checked:bg-darius-purple" />
                                    <span class="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                                </div>
                            </label>

                            <Show when={gridEnabled()}>
                                <div class="rounded-md border border-darius-border bg-darius-card-hover/30 p-3">
                                    <GridSettingsFields
                                        form={gridForm}
                                        rowInputCount={gridRowInputCount}
                                        idPrefix="group-grid"
                                    />
                                </div>
                            </Show>
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
