import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { CreateCanvasDialog } from "./CreateCanvasDialog";
import { useCanvasContext } from "../contexts/CanvasContext";
import { StyledSelect } from "./StyledSelect";

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
            <label class="mb-2 block text-sm font-medium text-slate-200">
                Select Canvas
            </label>
            <Show
                when={!canvases.loading}
                fallback={<div class="text-sm text-slate-400">Loading canvases...</div>}
            >
                <div class="group relative flex">
                    <StyledSelect
                        class="!static flex-1 [&>button]:rounded-r-none [&>button]:border-r-0 [&>button]:transition-colors [&>button]:group-hover:border-purple-400"
                        value={props.selectedId || ""}
                        onChange={(value) => {
                            if (value) {
                                handleSelect(value);
                            }
                        }}
                        theme="purple"
                        placeholder="Choose a canvas..."
                        options={
                            canvases()?.map((canvas: { id: string; name: string }) => ({
                                value: canvas.id,
                                label: canvas.name
                            })) ?? []
                        }
                    />
                    <button
                        onClick={handleCreateNew}
                        class="flex h-10 items-center justify-center rounded-r-md border border-l-0 border-purple-700 bg-slate-700 px-3 text-slate-400 transition-colors hover:bg-purple-600 hover:text-slate-200 group-hover:border-purple-400"
                        title="Create New Canvas"
                    >
                        <svg
                            class="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M12 4v16m8-8H4"
                            />
                        </svg>
                    </button>
                </div>
            </Show>

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
