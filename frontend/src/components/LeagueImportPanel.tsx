import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on
} from "solid-js";
import { createMutation, useQuery } from "@tanstack/solid-query";
import toast from "solid-toast";
import { ApiError } from "../utils/apiClient";
import {
    fetchEsclubTournamentSeries,
    fetchTeamsManage,
    sendLeagueSeriesToCanvas
} from "../utils/actions";
import {
    finishedIds,
    focusGroupId,
    leagueOptions,
    leagueSendErrorMessage,
    leagueTeamOptions,
    onCanvasSeriesIds,
    sendButtonLabel,
    sendResultToast,
    seedSelection,
    seriesPickerRows,
    type LeagueCanvasGroup,
    type SeriesSelection
} from "../utils/leagueImport";
import { rowStepFor } from "../utils/leagueSendLayout";
import type { CardLayout } from "../utils/canvasCardLayout";
import { StyledSelect } from "./StyledSelect";

/** The team select's "every series of the league" choice. */
const ALL_TEAMS = "__all__";

type Props = {
    canvasId: string;
    positionX: number;
    positionY: number;
    cardLayout: CardLayout;
    /** The canvas's groups: linked leagues and the series already sent here. */
    canvasGroups: LeagueCanvasGroup[];
    onClose: () => void;
    /** Refetch the canvas, then pan to this group. */
    onFocusGroup: (groupId: string) => void;
};

/**
 * "From league" (S3 Q1 A, Q4 A): pick a league and a team, then a checklist
 * of its series (finished ones pre-checked, newest first); "Send N series"
 * puts them on this canvas as a column at the dialog's point.
 */
export const LeagueImportPanel: Component<Props> = (props) => {
    const [leagueId, setLeagueId] = createSignal("");
    const [teamChoice, setTeamChoice] = createSignal("");
    const [selection, setSelection] = createSignal<SeriesSelection>({
        seededFor: null,
        checked: new Set()
    });

    const manageQuery = useQuery(() => ({
        queryKey: ["teamsManage"],
        queryFn: fetchTeamsManage
    }));

    const leagues = createMemo(() =>
        leagueOptions(manageQuery.data?.tournaments ?? [], props.canvasGroups)
    );
    const teams = createMemo(() =>
        leagueId()
            ? leagueTeamOptions(
                  leagueId(),
                  manageQuery.data?.teams ?? [],
                  props.canvasGroups
              )
            : []
    );
    const teamOptions = createMemo(() => [
        { value: ALL_TEAMS, label: "All teams" },
        ...teams().map((t) => ({ value: t.id, label: t.name }))
    ]);

    const seriesQuery = useQuery(() => ({
        queryKey: ["esclubTournamentSeries", leagueId(), teamChoice()],
        queryFn: () =>
            fetchEsclubTournamentSeries(
                leagueId(),
                teamChoice() === ALL_TEAMS ? null : teamChoice()
            ),
        enabled: leagueId() !== "" && teamChoice() !== "",
        staleTime: 0
    }));

    const onCanvas = createMemo(() => onCanvasSeriesIds(props.canvasGroups));
    const rows = createMemo(() =>
        seriesPickerRows(seriesQuery.data?.series ?? [], onCanvas())
    );

    // Seed the selection once per league and team, when its list arrives:
    // neither a background refetch of the same list nor a canvas change under
    // the open dialog drops the user's picks.
    createEffect(
        on([() => seriesQuery.data, leagueId, teamChoice], ([data, league, team]) =>
            setSelection((prev) =>
                seedSelection(prev, `${league}|${team}`, data ? rows() : null)
            )
        )
    );
    const checked = () => selection().checked;
    const setChecked = (next: Set<string>) =>
        setSelection((prev) => ({ ...prev, checked: next }));

    const selectedIds = createMemo(() =>
        rows()
            .filter((r) => !r.disabled && checked().has(r.id))
            .map((r) => r.id)
    );
    const button = createMemo(() => sendButtonLabel(selectedIds().length));
    // "Check all finished" is uncapped on purpose (the Send button then
    // names the 50 cap); the default selection is capped (checkedIds).
    const finished = createMemo(() => finishedIds(rows()));

    const toggle = (id: string) => {
        const next = new Set(checked());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setChecked(next);
    };

    const sendMutation = createMutation(() => ({
        mutationFn: (ids: string[]) =>
            sendLeagueSeriesToCanvas({
                canvasId: props.canvasId,
                leagueSeriesIds: ids,
                positionX: props.positionX,
                positionY: props.positionY,
                rowStep: rowStepFor(props.cardLayout)
            }),
        onSuccess: (result) => {
            const message = sendResultToast(result);
            if (result.created.length > 0 || result.existing.length > 0)
                toast.success(message);
            else toast.error(message);
            const focus = focusGroupId(result);
            if (focus) {
                props.onFocusGroup(focus);
                props.onClose();
            }
        },
        onError: (error: Error) => {
            toast.error(
                leagueSendErrorMessage(error instanceof ApiError ? error.status : null)
            );
        }
    }));

    return (
        <div class="flex max-h-[31.5rem] min-h-[31.5rem] flex-col gap-4">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="block text-sm font-medium text-darius-text-secondary">
                    League
                    <div class="mt-2">
                        <StyledSelect
                            value={leagueId()}
                            onChange={(value) => {
                                setLeagueId(value);
                                setTeamChoice("");
                            }}
                            options={leagues().map((l) => ({
                                value: l.id,
                                label: l.name
                            }))}
                            placeholder={
                                manageQuery.isPending ? "Loading…" : "Choose a league"
                            }
                            disabled={leagues().length === 0}
                            theme="purple"
                        />
                    </div>
                </label>
                <label class="block text-sm font-medium text-darius-text-secondary">
                    Team
                    <div class="mt-2">
                        <StyledSelect
                            value={teamChoice()}
                            onChange={setTeamChoice}
                            options={teamOptions()}
                            placeholder="Choose a team"
                            disabled={leagueId() === ""}
                            theme="purple"
                        />
                    </div>
                </label>
            </div>

            <div class="custom-scrollbar min-h-0 flex-1 overflow-y-auto rounded-md border border-darius-border bg-darius-card">
                <Show
                    when={!manageQuery.isError}
                    fallback={
                        <div class="p-4 text-darius-text-secondary">
                            Couldn't load your leagues.
                        </div>
                    }
                >
                    <Show
                        when={manageQuery.isPending || leagues().length > 0}
                        fallback={
                            <div class="p-4 text-darius-text-secondary">
                                No esclub leagues yet. Add one on the Teams page.
                            </div>
                        }
                    >
                        <Show
                            when={leagueId() !== "" && teamChoice() !== ""}
                            fallback={
                                <div class="p-4 text-darius-text-secondary">
                                    Choose a league and a team to list its series.
                                </div>
                            }
                        >
                            <Show
                                when={!seriesQuery.isError}
                                fallback={
                                    <div class="p-4 text-darius-text-secondary">
                                        Couldn't load the series.
                                    </div>
                                }
                            >
                                <Show
                                    when={!seriesQuery.isPending}
                                    fallback={
                                        <div class="p-4 text-darius-text-secondary">
                                            Loading...
                                        </div>
                                    }
                                >
                                    <Show
                                        when={rows().length > 0}
                                        fallback={
                                            <div class="p-4 text-darius-text-secondary">
                                                No series found
                                            </div>
                                        }
                                    >
                                        <For each={rows()}>
                                            {(row) => (
                                                <label
                                                    class="flex items-center gap-3 border-b border-darius-border px-4 py-2"
                                                    classList={{
                                                        "cursor-pointer hover:bg-darius-card-hover":
                                                            !row.disabled,
                                                        "opacity-60": row.disabled
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={
                                                            !row.disabled &&
                                                            checked().has(row.id)
                                                        }
                                                        disabled={row.disabled}
                                                        onChange={() => toggle(row.id)}
                                                        class="h-4 w-4 flex-shrink-0 accent-darius-purple"
                                                    />
                                                    <span class="min-w-0 flex-1 truncate text-sm text-darius-text-primary">
                                                        {row.label}
                                                    </span>
                                                    <Show when={row.note}>
                                                        {(note) => (
                                                            <span class="shrink-0 text-xs text-darius-text-secondary">
                                                                {note()}
                                                            </span>
                                                        )}
                                                    </Show>
                                                </label>
                                            )}
                                        </For>
                                    </Show>
                                </Show>
                            </Show>
                        </Show>
                    </Show>
                </Show>
            </div>

            <div class="flex flex-wrap items-center justify-end gap-2">
                <div class="mr-auto flex gap-2">
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-sm text-darius-text-secondary transition-colors hover:text-darius-purple-bright disabled:opacity-50 disabled:hover:text-darius-text-secondary"
                        disabled={selectedIds().length === 0}
                        onClick={() => setChecked(new Set())}
                    >
                        Check none
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-sm text-darius-text-secondary transition-colors hover:text-darius-purple-bright disabled:opacity-50 disabled:hover:text-darius-text-secondary"
                        disabled={finished().size === 0}
                        onClick={() => setChecked(finished())}
                    >
                        Check all finished
                    </button>
                </div>
                <button
                    type="button"
                    class="rounded-md bg-darius-card px-4 py-2 text-sm text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                    onClick={() => props.onClose()}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    class="rounded-md bg-darius-purple px-4 py-2 text-sm text-darius-text-primary transition-colors hover:bg-darius-purple-bright disabled:opacity-50 disabled:hover:bg-darius-purple"
                    disabled={button().disabled || sendMutation.isPending}
                    onClick={() => sendMutation.mutate(selectedIds())}
                >
                    {sendMutation.isPending ? "Sending..." : button().label}
                </button>
            </div>
        </div>
    );
};
