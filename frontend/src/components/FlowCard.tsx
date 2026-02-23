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
    const getAccentColor = () => {
        if (props.disabled) return "bg-slate-700";
        switch (props.flowType) {
            case "draft":
                return "bg-blue-500";
            case "canvas":
                return "bg-purple-500";
            case "versus":
                return "bg-orange-500";
            default:
                return "bg-teal-500";
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

    const baseClasses = props.disabled
        ? "cursor-not-allowed bg-slate-800 text-slate-500"
        : "bg-slate-800 text-slate-200 hover:bg-slate-700/80";

    const getGradient = () => {
        switch (props.flowType) {
            case "draft":
                return "from-blue-500/5 to-transparent";
            case "canvas":
                return "from-purple-500/5 to-transparent";
            case "versus":
                return "from-orange-500/5 to-transparent";
            default:
                return "from-teal-500/5 to-transparent";
        }
    };

    return (
        <button
            onClick={props.onClick}
            disabled={props.disabled}
            class={`relative flex overflow-hidden rounded-xl border border-slate-700/50 transition-all ${baseClasses}`}
        >
            {/* Subtle gradient overlay */}
            <div
                class={`pointer-events-none absolute inset-0 bg-gradient-to-r ${getGradient()}`}
            />

            {/* Side accent stripe */}
            <div class={`w-2 flex-shrink-0 ${getAccentColor()}`} />

            {/* Content */}
            <div class="relative flex flex-col items-start gap-4 p-8">
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
            </div>
        </button>
    );
};

export default FlowCard;
