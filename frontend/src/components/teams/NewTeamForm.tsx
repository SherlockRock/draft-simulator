import { Component, createSignal, Show } from "solid-js";
import { Check, Plus, X } from "lucide-solid";
import toast from "solid-toast";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { createTeam } from "../../utils/actions";
import { NEW_TEAM_NAME_MAX, parseNewTeamName } from "../../utils/teamsPage";
import { invalidateTeams } from "./invalidateTeams";

// "+ New team": an inline name field that creates a pickup team.
export const NewTeamForm: Component = () => {
    const queryClient = useQueryClient();
    const [open, setOpen] = createSignal(false);
    const [name, setName] = createSignal("");

    const close = () => {
        setOpen(false);
        setName("");
    };

    const createMutation = useMutation(() => ({
        mutationFn: (teamName: string) => createTeam(teamName),
        onSuccess: () => {
            void invalidateTeams(queryClient);
            close();
            toast.success("Team created");
        },
        onError: (error: Error) => toast.error(`Could not create team: ${error.message}`)
    }));

    const submit = () => {
        if (createMutation.isPending) return;
        const parsed = parseNewTeamName(name());
        if (parsed === null) {
            toast.error(`Team name must be 1 to ${NEW_TEAM_NAME_MAX} characters`);
            return;
        }
        createMutation.mutate(parsed);
    };

    return (
        <Show
            when={open()}
            fallback={
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    class="flex items-center gap-1 rounded-md border border-darius-border bg-darius-card-hover px-2.5 py-1 text-sm text-darius-text-secondary transition-colors hover:bg-darius-border"
                >
                    <Plus size={14} />
                    <span>New team</span>
                </button>
            }
        >
            <div class="flex items-center gap-1">
                <input
                    type="text"
                    value={name()}
                    maxLength={NEW_TEAM_NAME_MAX}
                    placeholder="Team name"
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onInput={(e) => setName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") submit();
                        if (e.key === "Escape") close();
                    }}
                    class="w-44 rounded-md border border-darius-border bg-darius-card-hover px-2 py-1 text-sm text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                />
                <button
                    type="button"
                    onClick={submit}
                    disabled={createMutation.isPending}
                    class="rounded p-1.5 text-darius-purple-bright transition-colors hover:bg-darius-card-hover disabled:opacity-50"
                    title="Create"
                    aria-label="Create"
                >
                    <Check size={16} />
                </button>
                <button
                    type="button"
                    onClick={close}
                    class="rounded p-1.5 text-darius-text-secondary transition-colors hover:bg-darius-card-hover"
                    title="Cancel"
                    aria-label="Cancel"
                >
                    <X size={16} />
                </button>
            </div>
        </Show>
    );
};
