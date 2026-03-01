import { Component, createSignal, Show, JSX } from "solid-js";

interface FlowPanelProps {
    flow: "draft" | "canvas" | "versus" | null;
    children?: JSX.Element;
}

const flowColors = {
    canvas: {
        arrowHover: "group-hover:text-purple-400"
    },
    versus: {
        arrowHover: "group-hover:text-orange-400"
    },
    draft: {
        arrowHover: "group-hover:text-slate-300"
    }
};

const FlowPanel: Component<FlowPanelProps> = (props) => {
    const [isExpanded, setIsExpanded] = createSignal(true);

    const colors = () => (props.flow ? flowColors[props.flow] : null);

    return (
        <div
            class={`flex flex-col border-r border-slate-700 bg-slate-800 transition-[width] duration-300 ${
                isExpanded() ? "w-[max(18vw,260px)]" : "w-5"
            }`}
        >
            <div class="flex h-full">
                <div
                    class={`flex flex-1 flex-col overflow-hidden transition-[width] duration-150 ${
                        isExpanded() ? "w-full" : "w-0"
                    }`}
                >
                    <Show when={isExpanded()}>
                        <div class="flex h-full flex-1 flex-col">{props.children}</div>
                    </Show>
                </div>
                <button
                    onClick={() => setIsExpanded(!isExpanded())}
                    class="group flex w-5 items-center justify-center border-l border-slate-700 bg-slate-800 transition-colors hover:bg-slate-700"
                >
                    <span
                        class={`text-[10px] text-slate-500 transition-colors ${
                            colors()?.arrowHover ?? ""
                        }`}
                    >
                        {isExpanded() ? "◀" : "▶"}
                    </span>
                </button>
            </div>
        </div>
    );
};

export default FlowPanel;
