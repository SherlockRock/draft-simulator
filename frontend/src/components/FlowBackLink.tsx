import { Component } from "solid-js";

interface FlowBackLinkProps {
    flowType: "canvas" | "versus";
    label: string;
    onClick: () => void;
}

const colorMap = {
    canvas: { text: "text-darius-purple-bright", hover: "text-darius-purple-bright" },
    versus: { text: "text-darius-crimson", hover: "text-darius-crimson" }
};

const FlowBackLink: Component<FlowBackLinkProps> = (props) => {
    const colors = () => colorMap[props.flowType];

    return (
        <div class="px-3">
            <button
                onClick={() => props.onClick()}
                class={`group flex items-center gap-2 transition-colors ${colors().text} ${colors().hover}`}
            >
                <span class="transition-transform group-hover:-translate-x-1">
                    &larr;
                </span>
                <span class="text-sm font-medium">{props.label}</span>
            </button>
        </div>
    );
};

export { FlowBackLink };
