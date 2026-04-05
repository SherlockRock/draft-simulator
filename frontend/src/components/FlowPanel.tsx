import { Component, createSignal, Show, JSX } from "solid-js";

interface FlowPanelProps {
    flow: "draft" | "canvas" | "versus" | null;
    children?: JSX.Element;
}

const flowColors = {
    canvas: {
        arrowHover: "group-hover:text-darius-purple-bright",
        borderAccent: "before:bg-darius-purple-bright"
    },
    versus: {
        arrowHover: "group-hover:text-darius-crimson",
        borderAccent: "before:bg-darius-crimson"
    },
    draft: {
        arrowHover: "group-hover:text-darius-text-secondary",
        borderAccent: "before:bg-darius-text-secondary"
    }
};

const FlowPanel: Component<FlowPanelProps> = (props) => {
    const [isExpanded, setIsExpanded] = createSignal(true);
    const [transitioning, setTransitioning] = createSignal(false);

    const colors = () => (props.flow ? flowColors[props.flow] : null);

    const toggle = () => {
        setTransitioning(true);
        setIsExpanded(!isExpanded());
        setTimeout(() => setTransitioning(false), 300);
    };

    return (
        <div
            class={`flex flex-col border-r border-darius-border bg-darius-card transition-[width] duration-300 ${
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
                    onClick={toggle}
                    class={`group relative flex w-5 items-center justify-center border-l border-darius-border bg-darius-card transition-[background-color] duration-200 before:absolute before:left-[-1px] before:top-1/2 before:z-10 before:h-0 before:w-0.5 before:transition-[height,top] before:duration-200 hover:bg-darius-card-hover hover:before:top-0 hover:before:h-full ${
                        !transitioning() ? (colors()?.borderAccent ?? "") : ""
                    }`}
                >
                    <span
                        class={`text-[10px] text-darius-text-secondary transition-colors ${
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
