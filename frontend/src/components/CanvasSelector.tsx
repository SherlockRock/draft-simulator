import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Plus } from "lucide-solid";
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
                        <Plus size={16} />
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
