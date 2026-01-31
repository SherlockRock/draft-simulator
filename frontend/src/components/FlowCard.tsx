import { Component, For, Show } from "solid-js";

interface FlowCardProps {
    title: string;
    description: string;
    icon: string;
    onClick: () => void;
    disabled?: boolean;
    flowType?: "draft" | "canvas" | "versus";
    bullets?: string[];
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

    const getBulletColor = () => {
        switch (props.flowType) {
            case "draft":
                return "bg-blue-400";
            case "canvas":
                return "bg-purple-400";
            case "versus":
                return "bg-orange-400";
            default:
                return "bg-teal-400";
        }
    };

    return (
        <button
            onClick={props.onClick}
            disabled={props.disabled}
            class={`flex flex-col items-start gap-4 rounded-xl border-2 p-10 transition-all ${getColorClasses()}`}
        >
            <div class="flex items-center gap-3">
                <span class="text-5xl">{props.icon}</span>
                <h3 class="text-3xl font-bold">{props.title}</h3>
            </div>
            <p class="text-base text-slate-400">{props.description}</p>
            <Show when={props.bullets && props.bullets.length > 0}>
                <ul class="space-y-2 text-left text-sm text-slate-300">
                    <For each={props.bullets}>
                        {(bullet) => (
                            <li class="flex items-start gap-2">
                                <span
                                    class={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${getBulletColor()}`}
                                />
                                {bullet}
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </button>
    );
};

export default FlowCard;
