import { Component, createSignal, Show } from "solid-js";

interface FlowPanelProps {
    flow: "draft" | "canvas" | "versus" | null;
    children?: any;
}

const FlowPanel: Component<FlowPanelProps> = (props) => {
    const [isExpanded, setIsExpanded] = createSignal(false);

    return (
        <div
            class={`flex flex-col bg-slate-800 transition-all duration-300 ${
                isExpanded() ? "w-[max(20vw,300px)]" : "w-6"
            }`}
        >
            <div class="flex h-full">
                <div
                    class={`flex flex-1 flex-col overflow-hidden transition-all duration-150 ${
                        isExpanded() ? "w-full" : "w-0"
                    }`}
                >
                    <Show when={isExpanded()}>
                        <div class="flex h-full flex-1 flex-col gap-4 px-4">
                            {props.children}
                        </div>
                    </Show>
                </div>
                <button
                    onClick={() => setIsExpanded(!isExpanded())}
                    class="flex w-6 items-center justify-center bg-slate-900 transition-colors hover:bg-slate-700"
                >
                    <span class="text-xs text-slate-400">
                        {isExpanded() ? "◀" : "▶"}
                    </span>
                </button>
            </div>
        </div>
    );
};

export default FlowPanel;
