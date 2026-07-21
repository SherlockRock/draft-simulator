import { Component, createSignal, For, Show } from "solid-js";
import { Pencil, Trash2, Check, X } from "lucide-solid";
import toast from "solid-toast";
import { useQuery, useQueryClient, useMutation } from "@tanstack/solid-query";
import type { Team } from "@draft-sim/shared-types";
import { fetchTeams, updateTeam, deleteTeam } from "../utils/actions";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";

export const MyTeamsSection: Component = () => {
    const queryClient = useQueryClient();
    const teamsQuery = useQuery(() => ({
        queryKey: ["teams"],
        queryFn: fetchTeams
    }));

    const [editingId, setEditingId] = createSignal<string | null>(null);
    const [editValue, setEditValue] = createSignal("");
    const [teamToDelete, setTeamToDelete] = createSignal<Team | null>(null);

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ["teams"] });

    const renameMutation = useMutation(() => ({
        mutationFn: (vars: { id: string; name: string }) =>
            updateTeam(vars.id, vars.name),
        onSuccess: () => {
            void invalidate();
            setEditingId(null);
            toast.success("Team renamed");
        },
        onError: (error: Error) => toast.error(`Rename failed: ${error.message}`)
    }));

    const deleteMutation = useMutation(() => ({
        mutationFn: (id: string) => deleteTeam(id),
        onSuccess: () => {
            void invalidate();
            setTeamToDelete(null);
            toast.success("Team deleted");
        },
        onError: (error: Error) => toast.error(`Delete failed: ${error.message}`)
    }));

    const startEdit = (team: Team) => {
        setEditingId(team.id);
        setEditValue(team.name);
    };

    const commitEdit = () => {
        const id = editingId();
        const name = editValue().trim();
        if (!id || name.length === 0) return;
        renameMutation.mutate({ id, name });
    };

    return (
        <div class="mb-6 rounded-lg border border-darius-border bg-darius-card p-6">
            <h2 class="mb-2 text-xl font-semibold text-darius-text-primary">My Teams</h2>
            <p class="mb-4 text-sm text-darius-text-secondary">
                Teams you link to series across your canvases. Renaming updates every
                linked series; deleting a team unlinks it (its saved name stays as text).
            </p>

            <Show
                when={(teamsQuery.data ?? []).length > 0}
                fallback={
                    <p class="text-sm text-darius-text-secondary">
                        No teams yet. Team names you type in a series group's settings can
                        be saved here.
                    </p>
                }
            >
                <div class="divide-y divide-darius-border rounded-md border border-darius-border">
                    <For each={teamsQuery.data ?? []}>
                        {(team) => (
                            <div class="flex items-center gap-2 px-3 py-2">
                                <Show
                                    when={editingId() === team.id}
                                    fallback={
                                        <>
                                            <span class="flex-1 truncate text-darius-text-primary">
                                                {team.name}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => startEdit(team)}
                                                class="rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-darius-purple-bright"
                                                title="Rename"
                                            >
                                                <Pencil size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setTeamToDelete(team)}
                                                class="rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-red-400"
                                                title="Delete"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </>
                                    }
                                >
                                    <input
                                        type="text"
                                        value={editValue()}
                                        maxLength={120}
                                        autofocus
                                        onInput={(e) =>
                                            setEditValue(e.currentTarget.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") commitEdit();
                                            if (e.key === "Escape") setEditingId(null);
                                        }}
                                        class="flex-1 rounded-md border border-darius-border bg-darius-card-hover px-2 py-1 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={commitEdit}
                                        disabled={renameMutation.isPending}
                                        class="rounded p-1.5 text-darius-purple-bright transition-colors hover:bg-darius-card-hover disabled:opacity-50"
                                        title="Save"
                                    >
                                        <Check size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setEditingId(null)}
                                        class="rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover"
                                        title="Cancel"
                                    >
                                        <X size={16} />
                                    </button>
                                </Show>
                            </div>
                        )}
                    </For>
                </div>
            </Show>

            <Dialog
                isOpen={() => teamToDelete() !== null}
                onCancel={() => setTeamToDelete(null)}
                onConfirm={() => {
                    const team = teamToDelete();
                    if (team) deleteMutation.mutate(team.id);
                }}
                body={
                    <div class="w-[min(100vw-2rem,24rem)] max-w-full">
                        <h2 class="mb-3 text-lg font-bold text-darius-text-primary">
                            Delete team
                        </h2>
                        <p class="mb-5 text-sm text-darius-text-secondary">
                            Delete{" "}
                            <span class="font-medium text-darius-text-primary">
                                {teamToDelete()?.name}
                            </span>
                            ? Any linked series keep their saved name as plain text. This
                            can't be undone.
                        </p>
                        <div class="flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setTeamToDelete(null)}
                                class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                            >
                                <span>Cancel</span>
                                <EscapeKeyHint />
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    const team = teamToDelete();
                                    if (team) deleteMutation.mutate(team.id);
                                }}
                                disabled={deleteMutation.isPending}
                                class="flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                            >
                                <span>Delete</span>
                                <ReturnKeyHint />
                            </button>
                        </div>
                    </div>
                }
            />
        </div>
    );
};
