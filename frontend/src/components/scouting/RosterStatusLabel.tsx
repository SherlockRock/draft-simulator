import { Component, Show } from "solid-js";

// Auto-save has no button and no dirty state, so this transient marker is the
// only feedback a successful write produces. Failures raise a toast.
export const RosterStatusLabel: Component<{ teamName: string; saved: boolean }> = (
    props
) => (
    <div class="flex items-center gap-2 px-1 text-xs text-slate-400">
        <span class="font-medium text-slate-300">{props.teamName}</span>
        <Show when={props.saved}>
            <span class="text-emerald-400">Saved ✓</span>
        </Show>
    </div>
);
