import { Component, Show } from "solid-js";
import { useNavigatorContext } from "../../contexts/NavigatorContext";

/** v5 phase 4: dev-only experimental engine toggle. Renders nothing when
 *  the backend's NAV_ENGINE_TOGGLE_ENABLED env var is unset (so production
 *  builds never see this UI). When enabled, lets the user flip between αβ
 *  and the MCTS spike on the active draft state. */
const EngineToggle: Component = () => {
    const { engineToggleEnabled, currentAlgorithm, setAlgorithm } = useNavigatorContext();

    return (
        <Show when={engineToggleEnabled()}>
            <div class="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-purple-500/40 bg-slate-900/90 px-2 py-1 shadow-sm">
                <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-purple-300">
                    Engine
                </span>
                <div class="inline-flex overflow-hidden rounded-full border border-slate-700/60">
                    <button
                        type="button"
                        class="px-2 py-0.5 text-[11px] font-medium transition-colors"
                        classList={{
                            "bg-slate-100 text-slate-900": currentAlgorithm() === "ab",
                            "text-slate-300 hover:bg-slate-800":
                                currentAlgorithm() !== "ab"
                        }}
                        onClick={() => setAlgorithm("ab")}
                    >
                        αβ
                    </button>
                    <button
                        type="button"
                        class="px-2 py-0.5 text-[11px] font-medium transition-colors"
                        classList={{
                            "bg-purple-500 text-white": currentAlgorithm() === "mcts",
                            "text-slate-300 hover:bg-slate-800":
                                currentAlgorithm() !== "mcts"
                        }}
                        onClick={() => setAlgorithm("mcts")}
                    >
                        MCTS
                    </button>
                </div>
            </div>
        </Show>
    );
};

export default EngineToggle;
