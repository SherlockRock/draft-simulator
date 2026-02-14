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
            <label class="mb-2 block text-sm font-medium text-slate-300">
                Select Canvas
            </label>
            <Show
                when={!canvases.loading}
                fallback={<div class="text-sm text-slate-400">Loading canvases...</div>}
            >
                <StyledSelect
                    class="mb-2"
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
