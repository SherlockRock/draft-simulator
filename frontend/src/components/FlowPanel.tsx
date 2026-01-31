import { Component, createSignal, Show } from "solid-js";

interface FlowPanelProps {
    flow: "draft" | "canvas" | "versus" | null;
    children?: any;
}

const FlowPanel: Component<FlowPanelProps> = (props) => {
    const [isExpanded, setIsExpanded] = createSignal(false);

    return (
        <div
            class={`flex flex-col border-r border-slate-700/50 bg-slate-800 transition-all duration-300 ${
                isExpanded() ? "w-[max(18vw,260px)]" : "w-5"
            }`}
        >
            <div class="flex h-full">
                <div
                    class={`flex flex-1 flex-col overflow-hidden transition-all duration-150 ${
                        isExpanded() ? "w-full" : "w-0"
                    }`}
                >
                    <Show when={isExpanded()}>
                        <div class="flex h-full flex-1 flex-col px-3">
                            {props.children}
                        </div>
                    </Show>
                </div>
                <button
                    onClick={() => setIsExpanded(!isExpanded())}
                    class="flex w-5 items-center justify-center border-l border-slate-700/30 bg-slate-800 transition-colors hover:bg-slate-700"
                >
                    <span class="text-[10px] text-slate-500">
                        {isExpanded() ? "◀" : "▶"}
                    </span>
                </button>
            </div>
        </div>
    );
};

export default FlowPanel;
