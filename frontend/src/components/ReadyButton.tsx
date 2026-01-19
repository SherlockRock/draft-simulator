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
        ready: "bg-gradient-to-br from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white shadow-lg shadow-emerald-500/40 hover:shadow-emerald-400/60 hover:scale-105 border-2 border-emerald-400/50",
        unready:
            "bg-gradient-to-br from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-900 shadow-lg shadow-amber-500/40 hover:shadow-amber-400/60 hover:scale-105 border-2 border-amber-400/50",
        starting:
            "bg-gradient-to-br from-violet-500 to-violet-600 text-white shadow-lg shadow-violet-500/50 border-2 border-violet-400/50 cursor-wait",
        lockin: "bg-gradient-to-br from-cyan-500 via-blue-500 to-blue-600 hover:from-cyan-400 hover:via-blue-400 hover:to-blue-500 text-white shadow-xl shadow-blue-500/50 hover:shadow-blue-400/70 hover:scale-110 border-2 border-cyan-400/60 hover:border-cyan-300",
        disabled:
            "bg-slate-700/50 text-slate-500 cursor-not-allowed border-2 border-slate-600/30 shadow-none"
    };

    return (
        <button
            onClick={handleClick}
            disabled={isDisabled()}
            class={`
                group relative overflow-hidden
                rounded-lg px-12 py-4
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
