import { Component, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useCanvasContext } from "../contexts/CanvasContext";
import { StyledSelect } from "./StyledSelect";

interface CanvasSelectorProps {
    selectedId: string | null;
}

const CanvasSelector: Component<CanvasSelectorProps> = (props) => {
    const navigate = useNavigate();
    const { canvasList: canvases } = useCanvasContext();

    const handleSelect = (canvasId: string) => {
        navigate(`/canvas/${canvasId}`);
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
                <StyledSelect
                    class="!static flex-1"
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
        </div>
    );
};

export default CanvasSelector;
