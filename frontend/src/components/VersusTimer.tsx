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
            <div
                class={`text-3xl font-bold transition-colors ${
                    props.isPaused
                        ? "text-yellow-500"
                        : isLowTime()
                          ? "text-red-500"
                          : "text-teal-400"
                }`}
            >
                {timeRemaining()}s
                {props.isPaused && <span class="ml-2 text-sm">(Paused)</span>}
            </div>
        </Show>
    );
};
