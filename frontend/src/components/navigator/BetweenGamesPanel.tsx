import { Component, Show, createSignal } from "solid-js";
import type {
    NavigatorDraftData,
    NavigatorSessionData
} from "../../contexts/NavigatorContext";
import { getProjectedSideForGameNumber } from "../../utils/navigatorSide";
import { PoolEditModal } from "./PoolEditModal";

interface BetweenGamesPanelProps {
    session: NavigatorSessionData;
    completedDraft: NavigatorDraftData; // the just-finished game
    isSeriesComplete: boolean;
    onStartNextGame: (override?: "blue" | "red") => void;
    onSavePools: (
        blue: NavigatorSessionData["blue_pool"],
        red: NavigatorSessionData["red_pool"]
    ) => void;
}

export const BetweenGamesPanel: Component<BetweenGamesPanelProps> = (props) => {
    const [editOpen, setEditOpen] = createSignal(false);
    const [manualChoice, setManualChoice] = createSignal<"blue" | "red" | null>(null);

    const nextGameNumber = () => props.completedDraft.game_number + 1;

    const autoSide = () => getProjectedSideForGameNumber(props.session, nextGameNumber());

    const handleStart = () => {
        if (props.session.side_swap_mode === "manual") {
            const choice = manualChoice();
            if (!choice) return;
            props.onStartNextGame(choice);
            return;
        }
        props.onStartNextGame();
    };

    const canStart = () =>
        props.session.side_swap_mode === "auto" || manualChoice() !== null;

    return (
        <div class="flex h-full flex-col gap-4 p-6">
            <Show
                when={!props.isSeriesComplete}
                fallback={
                    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                        <div class="text-lg font-semibold text-slate-100">
                            Series Complete
                        </div>
                        <p class="text-sm text-slate-400">
                            Review any game using the tabs above.
                        </p>
                    </div>
                }
            >
                <div>
                    <div class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Game {props.completedDraft.game_number} Complete
                    </div>
                    <div class="mt-2 text-lg font-semibold text-slate-100">
                        Next up: Game {nextGameNumber()}
                    </div>
                </div>

                <Show
                    when={props.session.side_swap_mode === "auto"}
                    fallback={
                        <div class="flex flex-col gap-2">
                            <span class="text-sm text-slate-300">Choose your side</span>
                            <div class="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setManualChoice("blue")}
                                    class={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                                        manualChoice() === "blue"
                                            ? "border-blue-400 bg-blue-500 text-white"
                                            : "border-slate-600 bg-transparent text-slate-300 hover:border-blue-400/60"
                                    }`}
                                >
                                    Blue
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setManualChoice("red")}
                                    class={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                                        manualChoice() === "red"
                                            ? "border-red-400 bg-red-500 text-white"
                                            : "border-slate-600 bg-transparent text-slate-300 hover:border-red-400/60"
                                    }`}
                                >
                                    Red
                                </button>
                            </div>
                        </div>
                    }
                >
                    <div class="text-sm text-slate-300">
                        You're on{" "}
                        <span
                            class={
                                autoSide() === "blue" ? "text-blue-300" : "text-red-300"
                            }
                        >
                            {autoSide() === "blue" ? "Blue" : "Red"}
                        </span>
                    </div>
                </Show>

                <div class="mt-auto flex flex-col gap-2">
                    <button
                        type="button"
                        onClick={() => setEditOpen(true)}
                        class="rounded-md border border-slate-600 bg-slate-800 px-4 py-3 text-sm font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-700"
                    >
                        Edit Pools
                    </button>
                    <button
                        type="button"
                        onClick={handleStart}
                        disabled={!canStart()}
                        class="rounded-md bg-blue-500 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                    >
                        Start Game {nextGameNumber()}
                    </button>
                </div>
            </Show>

            <PoolEditModal
                isOpen={editOpen}
                initialBluePool={props.session.blue_pool}
                initialRedPool={props.session.red_pool}
                onSave={(blue, red) => props.onSavePools(blue, red)}
                onClose={() => setEditOpen(false)}
            />
        </div>
    );
};
