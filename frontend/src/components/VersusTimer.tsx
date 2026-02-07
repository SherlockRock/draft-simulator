import { Component, createSignal, createEffect, onCleanup, Show } from "solid-js";

interface VersusTimerProps {
    timerStartedAt: number | null;
    duration: number; // in seconds
    isPaused: boolean;
}

export const VersusTimer: Component<VersusTimerProps> = (props) => {
    const [timeRemaining, setTimeRemaining] = createSignal(props.duration);

    createEffect(() => {
        // If no timer started, show full duration
        if (!props.timerStartedAt) {
            setTimeRemaining(props.duration);
            return;
        }

        // If paused, stop updating but keep current value
        if (props.isPaused) {
            return;
        }

        // Calculate and update remaining time
        const updateTimer = () => {
            const elapsed = (Date.now() - props.timerStartedAt!) / 1000;
            const remaining = Math.max(0, props.duration - elapsed);
            setTimeRemaining(Math.ceil(remaining));
        };

        // Initial update
        updateTimer();

        // Update every 100ms for smooth countdown
        const interval = setInterval(updateTimer, 100);

        onCleanup(() => clearInterval(interval));
    });

    const isLowTime = () => timeRemaining() < 10;

    return (
        <Show
            when={props.timerStartedAt}
            fallback={<div class="text-2xl font-bold text-slate-400">--</div>}
        >
            <div class="text-center">
                <Show
                    when={!props.isPaused}
                    fallback={
                        <span class="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/40 bg-yellow-500/15 px-3.5 py-1 text-center text-sm font-bold uppercase tracking-wider text-yellow-400">
                            <div class="h-2 w-2 animate-pulse rounded-full bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.6)]" />
                            <p>Paused</p>
                        </span>
                    }
                >
                    <span
                        class={`text-3xl font-bold transition-colors ${
                            isLowTime() ? "text-red-500" : "text-orange-400"
                        }`}
                    >
                        {timeRemaining()}s
                    </span>
                </Show>
            </div>
        </Show>
    );
};
