import { createSignal, For, createResource, Match, Switch, Show } from "solid-js";
import { Dialog } from "./Dialog";
import { generateNewCanvas, deleteCanvas, fetchDraftCanvases } from "../utils/actions";
import toast from "solid-toast";

interface CanvasListDialogProps {
    onClose: () => void;
    currentDraftId: string;
    onCanvasSelect: (canvasId: string) => void;
}

export const CanvasListDialog = (props: CanvasListDialogProps) => {
    const [creating, setCreating] = createSignal(false);
    const [deletingId, setDeletingId] = createSignal<string | null>(null);

    const [canvases, { refetch }] = createResource(async () => {
        const result = await fetchDraftCanvases(props.currentDraftId);
        if (!result) {
            throw new Error("Failed to load canvases");
        }
        return result.canvases;
    });

    const handleCreateCanvas = async () => {
        if (!props.currentDraftId) return;

        setCreating(true);
        const result = await generateNewCanvas(props.currentDraftId);
        setCreating(false);

        if (result) {
            refetch();
            toast.success("Canvas created successfully!");
            props.onCanvasSelect(result.canvas.id);
            props.onClose();
        } else {
            toast.error("Failed to create canvas");
        }
    };

    const handleDeleteCanvas = async (canvasId: string, event: MouseEvent) => {
        event.stopPropagation();
        setDeletingId(canvasId);

        const result = await deleteCanvas(canvasId);
        setDeletingId(null);

        if (result) {
            refetch();
            toast.success("Canvas deleted successfully!");
        } else {
            toast.error("Failed to delete canvas");
        }
    };

    const handleCanvasClick = (canvasId: string) => {
        props.onCanvasSelect(canvasId);
        props.onClose();
    };

    return (
        <Dialog
            isOpen={() => true}
            onCancel={props.onClose}
            body={
                <div class="w-96">
                    <div class="mb-4">
                        <h2 class="mb-2 text-xl font-bold text-slate-100">
                            Canvas Management
                        </h2>
                    </div>

                    <div class="mb-4">
                        <button
                            onClick={handleCreateCanvas}
                            disabled={creating() || !props.currentDraftId}
                            class="w-full rounded-md bg-teal-700 px-3 py-2 font-medium text-slate-200 hover:bg-teal-400 disabled:cursor-not-allowed disabled:bg-slate-600"
                        >
                            {creating() ? "Creating..." : "Create New Canvas"}
                        </button>
                    </div>

                    <div class="space-y-2">
                        <h3 class="text-sm font-medium text-slate-300">Your Canvases</h3>
                        <div class="custom-scrollbar max-h-96 overflow-y-auto">
                            <Switch>
                                <Match when={canvases.loading}>
                                    <div class="py-4 text-center text-slate-400">
                                        Loading...
                                    </div>
                                </Match>
                                <Match when={canvases.error}>
                                    <div class="py-4 text-center text-red-400">
                                        Failed to load canvases
                                    </div>
                                </Match>
                                <Match when={canvases()?.length === 0}>
                                    <div class="py-4 text-center text-slate-400">
                                        No canvases found
                                    </div>
                                </Match>
                                <Match when={canvases()}>
                                    <div class="space-y-2">
                                        <For each={canvases()}>
                                            {(canvas) => (
                                                <div
                                                    class="flex cursor-pointer items-center justify-between rounded-lg bg-slate-600 p-3 transition-colors hover:bg-slate-500"
                                                    onClick={() =>
                                                        handleCanvasClick(canvas.id)
                                                    }
                                                >
                                                    <div class="flex-1">
                                                        <div class="font-medium text-slate-50">
                                                            {canvas.name}
                                                        </div>
                                                        <div class="text-xs text-slate-200">
                                                            Created -{" "}
                                                            {new Date(
                                                                canvas.createdAt
                                                            ).toLocaleDateString()}
                                                        </div>
                                                    </div>
                                                    <Show
                                                        when={
                                                            canvas.permissions === "admin"
                                                        }
                                                    >
                                                        <button
                                                            onClick={(e) =>
                                                                handleDeleteCanvas(
                                                                    canvas.id,
                                                                    e
                                                                )
                                                            }
                                                            disabled={
                                                                deletingId() === canvas.id
                                                            }
                                                            class="ml-2 rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-600"
                                                        >
                                                            {deletingId() === canvas.id
                                                                ? "Deleting..."
                                                                : "Delete"}
                                                        </button>
                                                    </Show>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                </Match>
                            </Switch>
                        </div>
                    </div>

                    <div class="mt-4 border-t border-slate-600 pt-4">
                        <button
                            onClick={props.onClose}
                            class="w-full rounded-md bg-teal-700 px-3 py-2 font-medium text-slate-200 hover:bg-teal-400"
                        >
                            Close
                        </button>
                    </div>
                </div>
            }
        />
    );
};
