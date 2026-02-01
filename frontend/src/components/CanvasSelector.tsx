import { Component, For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { CreateCanvasDialog } from "./CreateCanvasDialog";
import { useCanvasContext } from "../workflows/CanvasWorkflow";

interface CanvasSelectorProps {
    selectedId: string | null;
}

const CanvasSelector: Component<CanvasSelectorProps> = (props) => {
    const navigate = useNavigate();
    const { canvasList: canvases, refetchCanvasList } = useCanvasContext();
    const [showCreateDialog, setShowCreateDialog] = createSignal(false);

    const handleSelect = (canvasId: string) => {
        navigate(`/canvas/${canvasId}`);
    };

    const handleCreateNew = () => {
        setShowCreateDialog(true);
    };

    return (
        <div class="canvas-selector">
            <label class="mb-2 block text-sm font-medium text-slate-300">
                Select Canvas
            </label>
            <Show
                when={!canvases.loading}
                fallback={<div class="text-sm text-slate-400">Loading canvases...</div>}
            >
                <select
                    class="mb-2 w-full rounded-md bg-slate-700 px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    value={props.selectedId || ""}
                    onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (value) {
                            handleSelect(value);
                        }
                    }}
                >
                    <option value="">Choose a canvas...</option>
                    <For each={canvases()}>
                        {(canvas) => <option value={canvas.id}>{canvas.name}</option>}
                    </For>
                </select>
            </Show>

            <button
                onClick={handleCreateNew}
                class="w-full rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
            >
                Create New Canvas
            </button>

            <CreateCanvasDialog
                isOpen={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
                onSuccess={(canvasId) => {
                    setShowCreateDialog(false);
                    refetchCanvasList();
                    navigate(`/canvas/${canvasId}`);
                }}
            />
        </div>
    );
};

export default CanvasSelector;
