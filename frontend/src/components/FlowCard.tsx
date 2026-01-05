import { Component } from "solid-js";

interface FlowCardProps {
    title: string;
    description: string;
    icon: string;
    onClick: () => void;
    disabled?: boolean;
    flowType?: "draft" | "canvas" | "versus";
}

const FlowCard: Component<FlowCardProps> = (props) => {
    const getColorClasses = () => {
        if (props.disabled) {
            return "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500";
        }

        switch (props.flowType) {
            case "draft":
                return "border-blue-600/50 bg-slate-800 text-slate-200 hover:border-blue-500 hover:bg-slate-700";
            case "canvas":
                return "border-purple-600/50 bg-slate-800 text-slate-200 hover:border-purple-500 hover:bg-slate-700";
            case "versus":
                return "border-orange-600/50 bg-slate-800 text-slate-200 hover:border-orange-500 hover:bg-slate-700";
            default:
                return "border-slate-600 bg-slate-800 text-slate-200 hover:border-teal-500 hover:bg-slate-700";
        }
    };

    return (
        <button
            onClick={props.onClick}
            disabled={props.disabled}
            class={`flex flex-col items-center gap-4 rounded-lg border-2 p-8 transition-all ${getColorClasses()}`}
        >
            <span class="text-5xl">{props.icon}</span>
            <h3 class="text-3xl font-bold">{props.title}</h3>
            <p class="text-center text-base text-slate-400">{props.description}</p>
        </button>
    );
};

export default FlowCard;
