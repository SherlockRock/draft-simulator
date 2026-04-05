import { Component, Show } from "solid-js";

interface ReadyButtonProps {
    isReady: boolean;
    opponentReady: boolean;
    draftStarted: boolean;
    isSpectator: boolean;
    onReady: () => void;
    onUnready: () => void;
    onLockIn: () => void;
    disabled?: boolean;
}

export const ReadyButton: Component<ReadyButtonProps> = (props) => {
    const handleClick = () => {
        if (!props.draftStarted) {
            // If already ready, allow unready
            if (props.isReady) {
                props.onUnready();
            } else {
                props.onReady();
            }
        } else {
            props.onLockIn();
        }
    };

    const getButtonText = () => {
        if (!props.draftStarted) {
            if (!props.isReady) return "Ready";
            if (props.isReady && !props.opponentReady) return "Unready";
            return "Starting...";
        }
        return "Lock In";
    };

    const isDisabled = () => {
        // Before draft: never disabled (allow ready/unready toggle)
        if (!props.draftStarted) {
            // Disable when both ready (draft is starting)
            return props.isReady && props.opponentReady;
        }
        // After draft (Lock In): disable if no champion hovered or other disabled reason
        return props.disabled || false;
    };

    const getButtonState = () => {
        if (isDisabled()) return "disabled";
        if (!props.draftStarted) {
            if (!props.isReady) return "ready";
            if (props.isReady && !props.opponentReady) return "unready";
            return "starting";
        }
        return "lockin";
    };

    const stateStyles = {
        ready: "bg-gradient-to-br from-darius-crimson to-darius-ember text-white shadow-lg shadow-darius-crimson/30 hover:scale-105 border-2 border-darius-crimson/50",
        unready:
            "bg-darius-crimson/15 text-darius-crimson hover:bg-darius-crimson/25 hover:scale-105 border-2 border-darius-crimson/60",
        starting:
            "bg-gradient-to-br from-darius-crimson/70 to-darius-ember/70 text-white shadow-lg shadow-darius-crimson/30 border-2 border-darius-crimson/40 cursor-wait",
        lockin: "bg-gradient-to-br from-darius-crimson to-darius-ember text-white shadow-lg shadow-darius-crimson/30 hover:scale-105 border-2 border-darius-crimson/50",
        disabled:
            "bg-darius-card-hover/50 text-darius-text-secondary cursor-not-allowed border-2 border-darius-border/30 shadow-none"
    };

    return (
        <Show when={!props.isSpectator}>
            <button
                onClick={handleClick}
                disabled={isDisabled()}
                class={`
                    group relative w-52
                    overflow-hidden rounded-lg py-4 text-center
                    text-[0.95rem] font-bold uppercase tracking-wider
                    transition-all duration-300 ease-out
                    active:scale-95 disabled:active:scale-100
                    ${stateStyles[getButtonState()]}
                `}
            >
                <span class="absolute inset-0 -left-full h-full w-full bg-gradient-to-r from-transparent via-white/20 to-transparent group-disabled:hidden" />

                {/* Button text */}
                <span class="relative z-10">{getButtonText()}</span>
            </button>
        </Show>
    );
};
