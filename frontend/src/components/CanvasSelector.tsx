import { Component, For, Show, createResource } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { fetchCanvasList } from "../utils/actions";
import toast from "solid-toast";

interface Canvas {
    id: string;
    name: string;
    updatedAt: string;
}

interface CanvasSelectorProps {
    selectedId: string | null;
}

const CanvasSelector: Component<CanvasSelectorProps> = (props) => {
    const navigate = useNavigate();
    const [canvases] = createResource<Canvas[]>(fetchCanvasList);

    const handleSelect = (canvasId: string) => {
        navigate(`/canvas/${canvasId}`);
    };

    const handleCreateNew = async () => {
        try {
            // For now, just navigate to canvas dashboard
            // In a full implementation, this would create a new canvas via API
            toast.success("Canvas creation coming soon!");
            navigate("/canvas");
        } catch (error) {
            console.error("Failed to create canvas:", error);
            toast.error("Failed to create canvas");
        }
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
                    class="mb-2 w-full rounded-md bg-slate-700 px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
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
                class="w-full rounded-md bg-teal-700 px-3 py-2 font-medium text-slate-200 transition-colors hover:bg-teal-600"
            >
                Create New Canvas
            </button>
        </div>
    );
};

export default CanvasSelector;
