import { Component, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Title } from "@solidjs/meta";
import { ChevronDown, ChevronRight } from "lucide-solid";
import toast from "solid-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type {
    BulkTeamAction,
    ManagedTeamRow,
    TeamsManageResponse
} from "@draft-sim/shared-types";
import { useUser } from "../userProvider";
import { AuthGuard } from "../components/AuthGuard";
import { TeamsGroup } from "../components/teams/TeamsGroup";
import { TeamsRow } from "../components/teams/TeamsRow";
import { TeamsBulkBar } from "../components/teams/TeamsBulkBar";
import { DeleteTeamsDialog } from "../components/teams/DeleteTeamsDialog";
import { NewTeamForm } from "../components/teams/NewTeamForm";
import { invalidateTeams } from "../components/teams/invalidateTeams";
import { bulkTeams, fetchTeamsManage, setTournamentArchived } from "../utils/actions";
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
        queryFn: fetchTeamsManage
    }));

    const groups = createMemo(() => {
        const data = teamsQuery.data;
        return data ? buildTeamsPageGroups(data) : [];
    });
    const tournamentGroups = createMemo(() =>
        groups().flatMap((g): TournamentGroup[] => (g.kind === "tournament" ? [g] : []))
    );
    // Zero or one item: <For> instead of a <Show> callback keeps the group typed.
    const pickupGroups = createMemo(() =>
        groups().flatMap((g): PickupGroup[] => (g.kind === "pickup" ? [g] : []))
    );
    const archivedGroups = createMemo(() =>
        groups().flatMap((g): ArchivedGroup[] => (g.kind === "archived" ? [g] : []))
    );

    const [selection, setSelection] = createSignal(emptySelection());
    const [deleteRows, setDeleteRows] = createSignal<ManagedTeamRow[]>([]);
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
        onError: (error: Error, vars) =>
            toast.error(`${BULK_FAILED[vars.action]}: ${error.message}`)
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
        const ids = [...selection().ids];
        if (ids.length > 0) bulkMutation.mutate({ action, ids, clear: true });
    };

    const requestDeleteSelected = () => {
        const data = teamsQuery.data;
        if (!data) return;
        const rows = selectedRows(selection(), data);
        if (rows.length > 0) setDeleteRows(rows);
    };

    const confirmDelete = () => {
        const ids = deleteRows().map((r) => r.id);
        if (ids.length === 0) return;
        // Rows deleted from the bar clear the selection; a single row doesn't.
        const clear = ids.every((id) => selection().ids.has(id));
        bulkMutation.mutate({ action: "delete", ids, clear });
    };

    const scopeOf = (team: ManagedTeamRow): SelectionScope =>
        team.archived_at ? "archived" : "active";

    const renderRow = (team: ManagedTeamRow) => (
        <TeamsRow
            team={team}
            selected={isRowSelected(selection(), team.id, scopeOf(team))}
            busy={busy()}
            onToggleSelected={() =>
                setSelection((prev) => toggleSelected(prev, team.id, scopeOf(team)))
            }
            onArchive={() => runRow("archive", team)}
            onRestore={() => runRow("restore", team)}
            onDelete={() => setDeleteRows([team])}
        />
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

    const leagueBody = (group: TournamentGroup) => (
        <div class={rowsDivider}>
            <For
                each={group.teams}
                fallback={
                    <p class="px-4 py-3 text-sm text-darius-text-secondary">
                        No teams in this league yet.
                    </p>
                }
            >
                {renderRow}
            </For>
        </div>
    );

    // A league you added can be archived; a manual-tournament group (teams you
    // own, no UserTournaments row) cannot.
    const leagueButton = (group: TournamentGroup, archived: boolean) => (
        <Show when={group.source !== "manual"}>
            <button
                type="button"
                onClick={() => leagueMutation.mutate({ id: group.id, archived })}
                disabled={busy()}
                class={SMALL_BUTTON}
            >
                {archived ? "Archive league" : "Restore league"}
            </button>
        </Show>
    );

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
                        <h1 class="mb-2 text-3xl font-bold text-darius-text-primary">
                            Teams
                        </h1>
                        <p class="mb-8 text-sm text-darius-text-secondary">
                            {PAGE_INTRO}
                        </p>

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
                            <For each={tournamentGroups()}>
                                {(group) => (
                                    <TeamsGroup
                                        title={group.name}
                                        region={regionLabel(group.region)}
                                        countLabel={teamCountLabel(group.teams.length)}
                                        actions={leagueButton(group, true)}
                                    >
                                        {leagueBody(group)}
                                    </TeamsGroup>
                                )}
                            </For>

                            <For each={pickupGroups()}>
                                {(group) => (
                                    <TeamsGroup
                                        title="Pickup teams"
                                        countLabel={teamCountLabel(group.teams.length)}
                                        actions={
                                            <>
                                                {selectAll(
                                                    selectableIds(group),
                                                    "active",
                                                    "Select all pickup teams"
                                                )}
                                                <NewTeamForm />
                                            </>
                                        }
                                    >
                                        <div class={rowsDivider}>
                                            <For
                                                each={group.teams}
                                                fallback={
                                                    <p class="px-4 py-3 text-sm text-darius-text-secondary">
                                                        No pickup teams yet. Use New team
                                                        to add one.
                                                    </p>
                                                }
                                            >
                                                {renderRow}
                                            </For>
                                        </div>
                                    </TeamsGroup>
                                )}
                            </For>

                            <For each={archivedGroups()}>
                                {(group) => (
                                    <TeamsGroup
                                        title={archivedHeaderLabel(group)}
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
                                                <For each={group.tournaments}>
                                                    {(league) => (
                                                        <TeamsGroup
                                                            title={league.name}
                                                            region={regionLabel(
                                                                league.region
                                                            )}
                                                            countLabel={teamCountLabel(
                                                                league.teams.length
                                                            )}
                                                            actions={leagueButton(
                                                                league,
                                                                false
                                                            )}
                                                        >
                                                            {leagueBody(league)}
                                                        </TeamsGroup>
                                                    )}
                                                </For>
                                                <Show when={group.pickupTeams.length > 0}>
                                                    <TeamsGroup
                                                        title="Pickup teams"
                                                        countLabel={teamCountLabel(
                                                            group.pickupTeams.length
                                                        )}
                                                        actions={selectAll(
                                                            selectableIds(group),
                                                            "archived",
                                                            "Select all archived pickup teams"
                                                        )}
                                                    >
                                                        <div class={rowsDivider}>
                                                            <For each={group.pickupTeams}>
                                                                {renderRow}
                                                            </For>
                                                        </div>
                                                    </TeamsGroup>
                                                </Show>
                                            </div>
                                        </Show>
                                    </TeamsGroup>
                                )}
                            </For>
                        </Show>
                    </div>
                </Show>
            </div>

            <Show when={selection().ids.size > 0}>
                <TeamsBulkBar
                    summary={summary()}
                    pending={bulkMutation.isPending}
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
        </AuthGuard>
    );
};

export default TeamsPage;
