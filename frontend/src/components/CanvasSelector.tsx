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
    let containerRef: HTMLDivElement | undefined;

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
                fallback={
                    <div class="text-sm text-darius-text-secondary">
                        Loading canvases...
                    </div>
                }
            >
                <div ref={containerRef} class="group relative flex">
                    <StyledSelect
                        class="!static flex-1 [&>button]:rounded-r-none [&>button]:border-r-0 [&>button]:transition-colors [&>button]:group-hover:border-darius-purple-bright"
                        dropdownWidthRef={containerRef}
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
                        class="flex h-10 items-center justify-center rounded-r-md border border-l-0 border-darius-purple-bright bg-darius-purple px-3 text-darius-text-primary transition-colors hover:bg-darius-purple-bright group-hover:border-darius-purple-bright"
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
