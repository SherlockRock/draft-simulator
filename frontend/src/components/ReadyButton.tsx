import { Component } from "solid-js";

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
    // Don't show for spectators
    if (props.isSpectator) return null;

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
        ready: "bg-gradient-to-br from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 text-white shadow-lg shadow-orange-500/40 hover:shadow-orange-400/60 hover:scale-105 border-2 border-orange-400/50",
        unready:
            "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 hover:scale-105 border-2 border-orange-500/60",
        starting:
            "bg-gradient-to-br from-orange-500/70 to-orange-600/70 text-white shadow-lg shadow-orange-500/30 border-2 border-orange-400/40 cursor-wait",
        lockin: "bg-gradient-to-br from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 text-white shadow-lg shadow-orange-500/40 hover:shadow-orange-400/60 hover:scale-105 border-2 border-orange-400/50",
        disabled:
            "bg-slate-700/50 text-slate-500 cursor-not-allowed border-2 border-slate-600/30 shadow-none"
    };

    return (
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
    );
};
