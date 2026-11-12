import { Component, createSignal, Show } from "solid-js";
import {
    Archive,
    ArchiveRestore,
    Check,
    ChevronDown,
    ChevronRight,
    Crosshair,
    Pencil,
    Trash2,
    X
} from "lucide-solid";
import { useNavigate } from "@solidjs/router";
import toast from "solid-toast";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import type { ManagedTeamRow } from "@draft-sim/shared-types";
import { updateTeam } from "../../utils/actions";
import { buildScoutLink, scoutLinkPath } from "../../utils/scoutLink";
import {
    isSelectable,
    playersLabel,
    regionLabel,
    teamDisplayName,
    useCountLabel
} from "../../utils/teamsPage";
import { TeamRosterEditor } from "../TeamRosterEditor";
import { invalidateTeams } from "./invalidateTeams";

const ACTION_CLASS =
    "rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-darius-purple-bright disabled:opacity-50";

// One team on one line (name, players, region, uses, actions); the roster
// opens below. Imported rows get Scout and the read-only roster only.
export const TeamsRow: Component<{
    team: ManagedTeamRow;
    selected: boolean;
    busy: boolean;
    onToggleSelected: () => void;
    onArchive: () => void;
    onRestore: () => void;
    onDelete: () => void;
}> = (props) => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = createSignal(false);
    const [editing, setEditing] = createSignal(false);
    const [editValue, setEditValue] = createSignal("");

    const renameMutation = useMutation(() => ({
        mutationFn: (name: string) => updateTeam(props.team.id, { name }),
        onSuccess: () => {
            void invalidateTeams(queryClient);
            setEditing(false);
            toast.success("Team renamed");
        },
        onError: (error: Error) => toast.error(`Rename failed: ${error.message}`)
    }));

    const scout = () => {
        const link = buildScoutLink(props.team, null);
        if (!link) {
            toast.error("Add players to this team's roster first");
            return;
        }
        navigate(scoutLinkPath(link));
    };

    const canRename = () =>
        !props.team.tournament_id && props.team.canEditRoster === true;
    const isArchived = () => Boolean(props.team.archived_at);

    const startEdit = () => {
        setEditValue(props.team.name);
        setEditing(true);
    };

    const commitEdit = () => {
        const name = editValue().trim();
        if (name.length === 0 || name.length > 120 || renameMutation.isPending) return;
        renameMutation.mutate(name);
    };

    return (
        <div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <Show when={isSelectable(props.team)}>
                    <input
                        type="checkbox"
                        checked={props.selected}
                        onChange={() => props.onToggleSelected()}
                        class="h-4 w-4 flex-shrink-0 accent-darius-purple"
                        aria-label={`Select ${props.team.name}`}
                    />
                </Show>
                <Show
                    when={editing()}
                    fallback={
                        <>
                            <div class="min-w-0 flex-1 basis-40">
                                <div class="truncate text-darius-text-primary">
                                    {teamDisplayName(props.team)}
                                </div>
                                <div class="flex flex-wrap gap-x-2 text-xs text-darius-text-secondary">
                                    <span>{playersLabel(props.team)}</span>
                                    <span>{regionLabel(props.team.region)}</span>
                                    <span>{useCountLabel(props.team.useCounts)}</span>
                                </div>
                            </div>
                            <div class="ml-auto flex flex-wrap items-center">
                                <button
                                    type="button"
                                    onClick={scout}
                                    class={ACTION_CLASS}
                                    title="Scout this team"
                                    aria-label="Scout this team"
                                >
                                    <Crosshair size={16} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setExpanded((cur) => !cur)}
                                    class={ACTION_CLASS}
                                    title={
                                        props.team.canEditRoster
                                            ? "Edit roster"
                                            : "Roster"
                                    }
                                    aria-label={
                                        props.team.canEditRoster
                                            ? "Edit roster"
                                            : "Roster"
                                    }
                                    aria-expanded={expanded()}
                                >
                                    <Show
                                        when={expanded()}
                                        fallback={<ChevronRight size={16} />}
                                    >
                                        <ChevronDown size={16} />
                                    </Show>
                                </button>
                                <Show when={canRename()}>
                                    <button
                                        type="button"
                                        onClick={startEdit}
                                        class={ACTION_CLASS}
                                        title="Rename"
                                        aria-label="Rename"
                                    >
                                        <Pencil size={16} />
                                    </button>
                                </Show>
                                <Show when={props.team.canArchive && !isArchived()}>
                                    <button
                                        type="button"
                                        onClick={() => props.onArchive()}
                                        disabled={props.busy}
                                        class={ACTION_CLASS}
                                        title="Archive"
                                        aria-label="Archive"
                                    >
                                        <Archive size={16} />
                                    </button>
                                </Show>
                                <Show when={props.team.canArchive && isArchived()}>
                                    <button
                                        type="button"
                                        onClick={() => props.onRestore()}
                                        disabled={props.busy}
                                        class={ACTION_CLASS}
                                        title="Restore"
                                        aria-label="Restore"
                                    >
                                        <ArchiveRestore size={16} />
                                    </button>
                                </Show>
                                <Show when={props.team.canDelete}>
                                    <button
                                        type="button"
                                        onClick={() => props.onDelete()}
                                        disabled={props.busy}
                                        class="rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-red-400 disabled:opacity-50"
                                        title="Delete"
                                        aria-label="Delete"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </Show>
                            </div>
                        </>
                    }
                >
                    <input
                        type="text"
                        value={editValue()}
                        maxLength={120}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        onInput={(e) => setEditValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditing(false);
                        }}
                        class="min-w-0 flex-1 basis-40 rounded-md border border-darius-border bg-darius-card-hover px-2 py-1 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                    />
                    <div class="flex items-center">
                        <button
                            type="button"
                            onClick={commitEdit}
                            disabled={renameMutation.isPending}
                            class="rounded p-1.5 text-darius-purple-bright transition-colors hover:bg-darius-card-hover disabled:opacity-50"
                            title="Save"
                            aria-label="Save"
                        >
                            <Check size={16} />
                        </button>
                        <button
                            type="button"
                            onClick={() => setEditing(false)}
                            class="rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover"
                            title="Cancel"
                            aria-label="Cancel"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </Show>
            </div>
            <Show when={expanded()}>
                <div class="px-4 pb-3">
                    <TeamRosterEditor
                        team={props.team}
                        onSaved={() => setExpanded(false)}
                    />
                </div>
            </Show>
        </div>
    );
};
