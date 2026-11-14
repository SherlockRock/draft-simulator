import {
    Component,
    createEffect,
    createMemo,
    createSignal,
    For,
    JSX,
    onCleanup,
    onMount,
    Show
} from "solid-js";
import { Title } from "@solidjs/meta";
import { ChevronDown, ChevronRight } from "lucide-solid";
import toast from "solid-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type {
    BulkTeamAction,
    EsclubSyncView,
    ManagedTeamRow,
    TeamsManageResponse
} from "@draft-sim/shared-types";
import { useUser } from "../userProvider";
import { AuthGuard } from "../components/AuthGuard";
import { AddLeagueDialog } from "../components/AddLeagueDialog";
import { TeamsGroup } from "../components/teams/TeamsGroup";
import { TeamsRow } from "../components/teams/TeamsRow";
import { TeamsBulkBar } from "../components/teams/TeamsBulkBar";
import { DeleteTeamsDialog } from "../components/teams/DeleteTeamsDialog";
import { NewTeamForm } from "../components/teams/NewTeamForm";
import { invalidateTeams } from "../components/teams/invalidateTeams";
import {
    bulkTeams,
    fetchEsclubSync,
    fetchEsclubTournament,
    fetchTeamsManage,
    refreshEsclubLeague,
    setTournamentArchived
} from "../utils/actions";
import {
    esclubActionMessage,
    esclubActionSync,
    esclubRefreshButton,
    esclubSyncPollInterval,
    type EsclubActionResult
} from "../utils/esclubSync";
import {
    PAGE_INTRO,
    allSelected,
    archivedHeaderLabel,
    buildTeamsPageGroups,
    emptySelection,
    isRowSelected,
    pruneSelection,
    regionLabel,
    selectableIds,
    selectedRows,
    selectionSummary,
    teamCountLabel,
    toggleGroupSelected,
    toggleSelected,
    type ArchivedGroup,
    type PickupGroup,
    type SelectionScope,
    type TournamentGroup
} from "../utils/teamsPage";

const BULK_DONE: Record<BulkTeamAction, string> = {
    archive: "Archived",
    restore: "Restored",
    delete: "Deleted"
};

const BULK_FAILED: Record<BulkTeamAction, string> = {
    archive: "Archive failed",
    restore: "Restore failed",
    delete: "Delete failed"
};

const SMALL_BUTTON =
    "rounded-md border border-darius-border bg-darius-card-hover px-2.5 py-1 text-sm text-darius-text-secondary transition-colors hover:bg-darius-border disabled:opacity-50";

const rowsDivider = "divide-y divide-darius-border border-t border-darius-border";

const TeamsPage: Component = () => {
    const context = useUser();
    const [user] = context();
    const queryClient = useQueryClient();

    const teamsQuery = useQuery(() => ({
        queryKey: ["teamsManage"],
        queryFn: fetchTeamsManage,
        // Wait for sign-in: a signed-out visit would 401 and retry.
        enabled: Boolean(user())
    }));

    const [addLeagueOpen, setAddLeagueOpen] = createSignal(false);
    const [syncs, setSyncs] = createSignal<EsclubSyncView[]>([]);
    const syncIds = createMemo(() => syncs().map((sync) => sync.id));
    const [now, setNow] = createSignal(Date.now());
    onMount(() => {
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        onCleanup(() => clearInterval(timer));
    });

    const trackSync = (sync: EsclubSyncView) => {
        setSyncs((previous) =>
            previous.some((item) => item.id === sync.id) ? previous : [...previous, sync]
        );
    };

    const handleEsclubResult = (result: EsclubActionResult) => {
        setNow(Date.now());
        const sync = esclubActionSync(result);
        if (sync) trackSync(sync);
        if (result.status === 200 && "known" in result.body) {
            void invalidateTeams(queryClient);
        }
        void queryClient.invalidateQueries({ queryKey: ["esclubTournament"] });
    };

    // Page-owned watchers survive closing Add league or collapsing Archived.
    // Stable ids keep a watcher mounted through teamsManage refetches.
    const SyncWatcher: Component<{ id: string }> = (props) => {
        const statusQuery = useQuery(() => ({
            queryKey: ["esclubSync", props.id],
            queryFn: () => fetchEsclubSync(props.id),
            enabled: Boolean(user()),
            retry: false,
            refetchInterval: (query) =>
                esclubSyncPollInterval(
                    query.state.data?.sync.status,
                    query.state.error !== null
                )
        }));

        createEffect(() => {
            const sync = statusQuery.data?.sync;
            if (!sync || sync.status === "running" || statusQuery.isFetching) return;
            setNow(Date.now());
            setSyncs((previous) => previous.filter((item) => item.id !== sync.id));
            void invalidateTeams(queryClient);
            void queryClient.invalidateQueries({ queryKey: ["esclubTournament"] });
            if (sync.status === "succeeded") toast.success("League sync finished");
            else
                toast.error(
                    "League sync failed. Saved teams have been refreshed; try again when available."
                );
        });

        return (
            <Show when={statusQuery.isError}>
                <p role="status" class="mb-4 text-sm text-slate-200">
                    Could not check the league sync.
                    <button
                        type="button"
                        onClick={() => void statusQuery.refetch()}
                        disabled={statusQuery.isFetching}
                        class="ml-2 text-teal-400 underline disabled:opacity-50"
                    >
                        Retry status
                    </button>
                </p>
            </Show>
        );
    };

    const RefreshLeagueButton: Component<{ id: string }> = (props) => {
        const tournamentQuery = useQuery(() => ({
            queryKey: ["esclubTournament", props.id],
            queryFn: () => fetchEsclubTournament(props.id),
            enabled: Boolean(user()),
            retry: false
        }));

        createEffect(() => {
            // A cached running row may already have finished. Wait for fresh data.
            if (tournamentQuery.isFetching) return;
            const running = tournamentQuery.data?.sync.running;
            if (running) trackSync(running);
        });

        const refreshMutation = useMutation(() => ({
            mutationFn: () => refreshEsclubLeague(props.id),
            retry: false,
            onSuccess: (result) => {
                handleEsclubResult(result);
                const message = esclubActionMessage(result, Date.now());
                if (result.status === 200 || result.status === 202)
                    toast.success(message);
                else toast.error(message);
            },
            onError: () => toast.error("Could not refresh the league. Please try again.")
        }));

        const state = createMemo(() => {
            const data = tournamentQuery.data;
            if (!data) return { label: "Refresh league", disabled: true };
            const running = syncs().find((sync) => sync.tournamentId === props.id);
            return esclubRefreshButton(
                {
                    ...data,
                    sync: { ...data.sync, running: running ?? data.sync.running }
                },
                now()
            );
        });

        return (
            <>
                <button
                    type="button"
                    onClick={() => refreshMutation.mutate()}
                    disabled={
                        refreshMutation.isPending ||
                        state().disabled ||
                        tournamentQuery.isError
                    }
                    class="rounded-md border border-teal-700 px-2.5 py-1 text-sm text-teal-400 transition-colors hover:bg-teal-700/20 disabled:opacity-50"
                >
                    {refreshMutation.isPending ? "Refreshing…" : state().label}
                </button>
                <Show when={tournamentQuery.isError}>
                    <button
                        type="button"
                        onClick={() => void tournamentQuery.refetch()}
                        disabled={tournamentQuery.isFetching}
                        class="text-sm text-teal-400 underline disabled:opacity-50"
                    >
                        Retry sync status
                    </button>
                </Show>
            </>
        );
    };

    // Everything below renders by stable string keys (team ids, league ids) and
    // looks the current object up in a Map. buildTeamsPageGroups returns fresh
    // objects on every run, and <For> keys objects by reference, so iterating
    // the objects would remount rows (and drop an open rename field, an
    // expanded roster editor or the New team form) on every refetch. <For>
    // compares strings by value, so the keyed components below stay mounted.
    const groups = createMemo(() => {
        const data = teamsQuery.data;
        return data ? buildTeamsPageGroups(data) : [];
    });
    const tournamentGroups = createMemo(() =>
        groups().flatMap((g): TournamentGroup[] => (g.kind === "tournament" ? [g] : []))
    );
    const pickupGroup = createMemo((): PickupGroup | undefined => {
        for (const g of groups()) if (g.kind === "pickup") return g;
        return undefined;
    });
    const archivedGroup = createMemo((): ArchivedGroup | undefined => {
        for (const g of groups()) if (g.kind === "archived") return g;
        return undefined;
    });
    const hasArchived = createMemo(() => archivedGroup() !== undefined);
    const archivedTitle = createMemo(() => {
        const g = archivedGroup();
        return g ? archivedHeaderLabel(g) : "Archived";
    });

    const teamsById = createMemo(
        () => new Map((teamsQuery.data?.teams ?? []).map((t) => [t.id, t]))
    );
    const leaguesById = createMemo(() => {
        const map = new Map<string, TournamentGroup>();
        for (const g of tournamentGroups()) map.set(g.id, g);
        for (const g of archivedGroup()?.tournaments ?? []) map.set(g.id, g);
        return map;
    });
    const activeLeagueIds = createMemo(() => tournamentGroups().map((g) => g.id));
    const archivedLeagueIds = createMemo(() =>
        (archivedGroup()?.tournaments ?? []).map((g) => g.id)
    );
    const pickupIds = createMemo(() => (pickupGroup()?.teams ?? []).map((t) => t.id));
    const archivedPickupIds = createMemo(() =>
        (archivedGroup()?.pickupTeams ?? []).map((t) => t.id)
    );
    const pickupSelectable = createMemo(() => {
        const g = pickupGroup();
        return g ? selectableIds(g) : [];
    });
    const archivedSelectable = createMemo(() => {
        const g = archivedGroup();
        return g ? selectableIds(g) : [];
    });

    const [selection, setSelection] = createSignal(emptySelection());
    const [deleteRows, setDeleteRows] = createSignal<ManagedTeamRow[]>([]);
    const [deleteFromBar, setDeleteFromBar] = createSignal(false);
    const [archivedOpen, setArchivedOpen] = createSignal(false);

    // After every refetch drop selected ids that are gone or no longer selectable.
    createEffect(() => {
        const data: TeamsManageResponse | undefined = teamsQuery.data;
        if (data) setSelection((prev) => pruneSelection(prev, data));
        else setSelection(emptySelection());
    });

    const summary = createMemo(() => {
        const data = teamsQuery.data;
        const rows = data ? selectedRows(selection(), data) : [];
        return selectionSummary(selection(), rows);
    });

    const bulkMutation = useMutation(() => ({
        mutationFn: (vars: { action: BulkTeamAction; ids: string[]; clear: boolean }) =>
            bulkTeams(vars.action, vars.ids),
        onSuccess: (result, vars) => {
            void invalidateTeams(queryClient);
            setDeleteRows([]);
            if (vars.clear) setSelection(emptySelection());
            toast.success(
                `${BULK_DONE[result.action]} ${teamCountLabel(result.ids.length)}`
            );
        },
        onError: (error: Error, vars) => {
            // Close the delete dialog: its rows are a snapshot that the failure
            // (e.g. a row gone elsewhere) may have made stale. Refresh the page data.
            setDeleteRows([]);
            void invalidateTeams(queryClient);
            toast.error(`${BULK_FAILED[vars.action]}: ${error.message}`);
        }
    }));

    const leagueMutation = useMutation(() => ({
        mutationFn: (vars: { id: string; archived: boolean }) =>
            setTournamentArchived(vars.id, vars.archived),
        onSuccess: (_result, vars) => {
            void invalidateTeams(queryClient);
            toast.success(vars.archived ? "League archived" : "League restored");
        },
        onError: (error: Error, vars) =>
            toast.error(
                `${vars.archived ? "Archive" : "Restore"} failed: ${error.message}`
            )
    }));

    const busy = () => bulkMutation.isPending || leagueMutation.isPending;

    const runRow = (action: BulkTeamAction, team: ManagedTeamRow) =>
        bulkMutation.mutate({ action, ids: [team.id], clear: false });

    const runSelected = (action: BulkTeamAction) => {
        const s = summary();
        const allowed = action === "archive" ? s.canArchive : s.canRestore;
        const ids = [...selection().ids];
        if (allowed && ids.length > 0) bulkMutation.mutate({ action, ids, clear: true });
    };

    const requestDeleteSelected = () => {
        const data = teamsQuery.data;
        if (!data || !summary().canDelete) return;
        const rows = selectedRows(selection(), data);
        if (rows.length > 0) {
            setDeleteFromBar(true);
            setDeleteRows(rows);
        }
    };

    const requestDeleteRow = (team: ManagedTeamRow) => {
        setDeleteFromBar(false);
        setDeleteRows([team]);
    };

    const confirmDelete = () => {
        const ids = deleteRows().map((r) => r.id);
        if (ids.length === 0) return;
        // A delete from the bar clears the selection. A single row deleted from
        // its own icon keeps the rest of the selection (the refetch prunes the
        // deleted id), even when that row was selected.
        bulkMutation.mutate({ action: "delete", ids, clear: deleteFromBar() });
    };

    const scopeOf = (team: ManagedTeamRow): SelectionScope =>
        team.archived_at ? "archived" : "active";

    // One row, by id. Stays mounted while the id exists; a removed id renders nothing.
    const RowById: Component<{ id: string }> = (props) => {
        const row = () => teamsById().get(props.id);
        return (
            <Show when={row()}>
                {(team) => (
                    <TeamsRow
                        team={team()}
                        selected={isRowSelected(selection(), team().id, scopeOf(team()))}
                        busy={busy()}
                        onToggleSelected={() =>
                            setSelection((prev) =>
                                toggleSelected(prev, team().id, scopeOf(team()))
                            )
                        }
                        onArchive={() => runRow("archive", team())}
                        onRestore={() => runRow("restore", team())}
                        onDelete={() => requestDeleteRow(team())}
                    />
                )}
            </Show>
        );
    };

    const RowList: Component<{ ids: string[]; empty?: JSX.Element }> = (props) => (
        <div class={rowsDivider}>
            <For each={props.ids} fallback={props.empty}>
                {(id) => <RowById id={id} />}
            </For>
        </div>
    );

    const selectAll = (ids: string[], scope: SelectionScope, label: string) => (
        <Show when={ids.length > 0}>
            <label class="flex items-center gap-1.5 text-sm text-darius-text-secondary">
                <input
                    type="checkbox"
                    checked={allSelected(selection(), ids, scope)}
                    onChange={() =>
                        setSelection((prev) => toggleGroupSelected(prev, ids, scope))
                    }
                    class="h-4 w-4 accent-darius-purple"
                    aria-label={label}
                />
                <span>Select all</span>
            </label>
        </Show>
    );

    // One league card, by id. `archiveTarget` is what its button sets: true on an
    // active league (Archive league), false inside Archived (Restore league).
    // A manual-tournament group (teams you own, no UserTournaments row) has no
    // button: the endpoint would 404.
    const LeagueCard: Component<{ id: string; archiveTarget: boolean }> = (props) => {
        const league = () => leaguesById().get(props.id);
        const teamIds = createMemo(() => (league()?.teams ?? []).map((t) => t.id));
        return (
            <Show when={league()}>
                {(l) => (
                    <TeamsGroup
                        title={l().name}
                        region={regionLabel(l().region)}
                        countLabel={teamCountLabel(l().teams.length)}
                        actions={
                            <>
                                <Show when={l().source === "esclub"}>
                                    <RefreshLeagueButton id={l().id} />
                                </Show>
                                <Show when={l().source !== "manual"}>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            leagueMutation.mutate({
                                                id: l().id,
                                                archived: props.archiveTarget
                                            })
                                        }
                                        disabled={busy()}
                                        class={SMALL_BUTTON}
                                    >
                                        {props.archiveTarget
                                            ? "Archive league"
                                            : "Restore league"}
                                    </button>
                                </Show>
                            </>
                        }
                    >
                        <RowList
                            ids={teamIds()}
                            empty={
                                <p class="px-4 py-3 text-sm text-darius-text-secondary">
                                    No teams in this league yet.
                                </p>
                            }
                        />
                    </TeamsGroup>
                )}
            </Show>
        );
    };

    return (
        <AuthGuard requireAuth>
            <Title>Teams - First Pick</Title>
            <div class="flex-1 overflow-auto bg-darius-bg">
                <Show
                    when={user()}
                    fallback={
                        <div class="flex h-full items-center justify-center">
                            <p class="text-darius-text-secondary">Loading...</p>
                        </div>
                    }
                >
                    <div class="mx-auto max-w-3xl p-4 pb-28 sm:p-8 sm:pb-28">
                        <div class="mb-2 flex items-center justify-between gap-3">
                            <h1 class="text-3xl font-bold text-darius-text-primary">
                                Teams
                            </h1>
                            <button
                                type="button"
                                onClick={() => setAddLeagueOpen(true)}
                                class="rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-slate-50 transition-colors hover:bg-teal-600"
                            >
                                Add league
                            </button>
                        </div>
                        <p class="mb-8 text-sm text-darius-text-secondary">
                            {PAGE_INTRO}
                        </p>

                        <For each={syncIds()}>{(id) => <SyncWatcher id={id} />}</For>

                        <Show when={teamsQuery.isError}>
                            <div class="mb-6 rounded-lg border border-darius-border bg-darius-card p-6">
                                <p class="mb-3 text-sm text-darius-text-primary">
                                    Could not load your teams.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => void teamsQuery.refetch()}
                                    class={SMALL_BUTTON}
                                >
                                    Try again
                                </button>
                            </div>
                        </Show>
                        <Show when={teamsQuery.isPending}>
                            <p class="text-darius-text-secondary">Loading teams...</p>
                        </Show>

                        <Show when={teamsQuery.data}>
                            <For each={activeLeagueIds()}>
                                {(id) => <LeagueCard id={id} archiveTarget={true} />}
                            </For>

                            {/* Rendered once, not per data object: the New team form stays mounted. */}
                            <TeamsGroup
                                title="Pickup teams"
                                countLabel={teamCountLabel(pickupIds().length)}
                                actions={
                                    <>
                                        {selectAll(
                                            pickupSelectable(),
                                            "active",
                                            "Select all pickup teams"
                                        )}
                                        <NewTeamForm />
                                    </>
                                }
                            >
                                <RowList
                                    ids={pickupIds()}
                                    empty={
                                        <p class="px-4 py-3 text-sm text-darius-text-secondary">
                                            No pickup teams yet. Use New team to add one.
                                        </p>
                                    }
                                />
                            </TeamsGroup>

                            <Show when={hasArchived()}>
                                <TeamsGroup
                                    title={archivedTitle()}
                                    leading={
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setArchivedOpen((open) => !open)
                                            }
                                            class="rounded p-1 text-darius-text-secondary transition-colors hover:bg-darius-card-hover"
                                            title={
                                                archivedOpen()
                                                    ? "Hide archived"
                                                    : "Show archived"
                                            }
                                            aria-label={
                                                archivedOpen()
                                                    ? "Hide archived"
                                                    : "Show archived"
                                            }
                                            aria-expanded={archivedOpen()}
                                        >
                                            <Show
                                                when={archivedOpen()}
                                                fallback={<ChevronRight size={18} />}
                                            >
                                                <ChevronDown size={18} />
                                            </Show>
                                        </button>
                                    }
                                >
                                    <Show when={archivedOpen()}>
                                        <div class="px-4 pb-4">
                                            <For each={archivedLeagueIds()}>
                                                {(id) => (
                                                    <LeagueCard
                                                        id={id}
                                                        archiveTarget={false}
                                                    />
                                                )}
                                            </For>
                                            <Show when={archivedPickupIds().length > 0}>
                                                <TeamsGroup
                                                    title="Pickup teams"
                                                    countLabel={teamCountLabel(
                                                        archivedPickupIds().length
                                                    )}
                                                    actions={selectAll(
                                                        archivedSelectable(),
                                                        "archived",
                                                        "Select all archived pickup teams"
                                                    )}
                                                >
                                                    <RowList ids={archivedPickupIds()} />
                                                </TeamsGroup>
                                            </Show>
                                        </div>
                                    </Show>
                                </TeamsGroup>
                            </Show>
                        </Show>
                    </div>
                </Show>
            </div>

            <Show when={selection().ids.size > 0}>
                <TeamsBulkBar
                    summary={summary()}
                    pending={busy()}
                    onArchive={() => runSelected("archive")}
                    onRestore={() => runSelected("restore")}
                    onDelete={requestDeleteSelected}
                    onClear={() => setSelection(emptySelection())}
                />
            </Show>

            <DeleteTeamsDialog
                rows={deleteRows()}
                pending={bulkMutation.isPending}
                onCancel={() => setDeleteRows([])}
                onConfirm={confirmDelete}
            />
            <AddLeagueDialog
                isOpen={addLeagueOpen()}
                onClose={() => setAddLeagueOpen(false)}
                onResult={handleEsclubResult}
            />
        </AuthGuard>
    );
};

export default TeamsPage;
