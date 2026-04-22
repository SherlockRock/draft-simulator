import { Component, createEffect, createSignal, Show } from "solid-js";
import toast from "solid-toast";
import type { RolePoolMap, SavedPool } from "@draft-sim/shared-types";
import { Dialog } from "../Dialog";
import { createSavedPool } from "../../utils/savedPoolsApi";

interface SavePoolAsDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    // RolePoolMap snapshot to save as a new SavedPool.
    champions: () => RolePoolMap;
    // Optional seed for the name input (e.g. pre-filled from JSON import).
    initialName?: () => string;
    // Fired after a successful save. Consumers can refresh their saved-pool list.
    onSaved?: (pool: SavedPool) => void;
}

export const SavePoolAsDialog: Component<SavePoolAsDialogProps> = (props) => {
    const [name, setName] = createSignal("");
    const [error, setError] = createSignal<string | null>(null);
    const [isSubmitting, setIsSubmitting] = createSignal(false);

    createEffect(() => {
        if (props.isOpen()) {
            setName(props.initialName?.() ?? "");
            setError(null);
        }
    });

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        const trimmed = name().trim();
        if (trimmed.length === 0) {
            setError("Name is required");
            return;
        }
        if (trimmed.length > 120) {
            setError("Name must be 120 characters or fewer");
            return;
        }
        setIsSubmitting(true);
        try {
            const created = await createSavedPool({
                name: trimmed,
                champions: props.champions()
            });
            toast.success(`Saved pool "${created.name}"`);
            props.onSaved?.(created);
            props.onClose();
        } catch {
            toast.error("Failed to save pool");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <form onSubmit={handleSubmit} class="w-96">
                    <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                        Save pool as…
                    </h2>
                    <label class="mb-4 block">
                        <span class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Pool name
                        </span>
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => {
                                setName(e.currentTarget.value);
                                if (error()) setError(null);
                            }}
                            placeholder="Team Liquid Red Side"
                            maxlength={120}
                            class="w-full appearance-none rounded border border-darius-border bg-darius-card px-3 py-2 text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright"
                            autofocus
                        />
                        <Show when={error()}>
                            <p class="mt-1 text-sm text-red-400">{error()}</p>
                        </Show>
                    </label>
                    <div class="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="rounded-md bg-darius-card px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting()}
                            class="rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isSubmitting() ? "Saving…" : "Save"}
                        </button>
                    </div>
                </form>
            }
        />
    );
};
