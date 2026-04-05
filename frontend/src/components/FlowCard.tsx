import { Component, JSX } from "solid-js";

interface FlowCardProps {
    title: string;
    description: string;
    icon: JSX.Element;
    onClick: () => void;
    onCtaClick: () => void;
    ctaLabel: string;
    disabled?: boolean;
    flowType?: "draft" | "canvas" | "versus";
}

const FlowCard: Component<FlowCardProps> = (props) => {
    const baseClasses = props.disabled
        ? "cursor-not-allowed bg-darius-card text-darius-text-secondary"
        : "bg-darius-card text-darius-text-primary hover:bg-darius-card-hover";

    const getGradient = () => {
        switch (props.flowType) {
            case "canvas":
                return "from-darius-purple/[0.08] to-transparent group-hover:from-darius-purple/[0.12]";
            case "versus":
                return "from-darius-crimson/[0.08] to-transparent group-hover:from-darius-crimson/[0.12]";
            default:
                return "from-darius-purple/[0.08] to-transparent group-hover:from-darius-purple/[0.12]";
        }
    };

    const getCtaClasses = () => {
        switch (props.flowType) {
            case "versus":
                return "bg-darius-crimson shadow-[0_4px_12px_rgba(224,56,72,0.15)] hover:shadow-[0_6px_16px_rgba(224,56,72,0.22)]";
            case "canvas":
            default:
                return "bg-darius-purple shadow-[0_4px_12px_rgba(122,56,128,0.15)] hover:shadow-[0_6px_16px_rgba(122,56,128,0.22)]";
        }
    };

    return (
        <div
            role="button"
            tabIndex={props.disabled ? -1 : 0}
            aria-disabled={props.disabled}
            onClick={() => {
                if (!props.disabled) {
                    props.onClick();
                }
            }}
            onKeyDown={(event) => {
                if (props.disabled) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onClick();
                }
            }}
            class={`group relative flex overflow-hidden rounded-xl border border-darius-border/50 transition-all ${baseClasses}`}
        >
            {/* Subtle gradient overlay */}
            <div
                class={`pointer-events-none absolute inset-0 bg-gradient-to-br transition-all ${getGradient()}`}
            />

            {/* Content */}
            <div class="relative flex flex-col items-start gap-4 p-6">
                <div class="flex items-center gap-3">
                    {props.icon}
                    <h3 class="text-xl font-bold">{props.title}</h3>
                </div>
                <p class="text-base text-darius-text-secondary">{props.description}</p>
                <button
                    type="button"
                    disabled={props.disabled}
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onCtaClick();
                    }}
                    class={`rounded-lg px-5 py-2.5 text-sm font-semibold text-darius-text-primary transition-all hover:brightness-125 ${getCtaClasses()}`}
                >
                    {props.ctaLabel}
                </button>
            </div>
        </div>
    );
};

export default FlowCard;
