import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { NavigatorScenario } from "../../contexts/NavigatorContext";
import ScenarioCard from "./ScenarioCard";

const CARD_WIDTH = 300;
const CARD_GAP = 16;
const SCROLL_STEP = CARD_WIDTH + CARD_GAP;

interface ScenarioLanesProps {
    scenarios: NavigatorScenario[];
    isComputing: boolean;
    selectedIndex: number | null;
    onSelectScenario: (index: number) => void;
}

const ScenarioLanes: Component<ScenarioLanesProps> = (props) => {
    let scrollRef: HTMLDivElement | undefined;
    const [canScrollLeft, setCanScrollLeft] = createSignal(false);
    const [canScrollRight, setCanScrollRight] = createSignal(false);

    const hasScenarios = createMemo(() => props.scenarios.length > 0);
    const showSkeletons = createMemo(
        () => props.isComputing && props.scenarios.length === 0
    );

    const updateScrollState = () => {
        if (!scrollRef) return;
        const { scrollLeft, scrollWidth, clientWidth } = scrollRef;
        setCanScrollLeft(scrollLeft > 0);
        setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
    };

    onMount(() => {
        if (!scrollRef) return;
        updateScrollState();
        scrollRef.addEventListener("scroll", updateScrollState, { passive: true });
        const observer = new ResizeObserver(updateScrollState);
        observer.observe(scrollRef);
        onCleanup(() => {
            scrollRef?.removeEventListener("scroll", updateScrollState);
            observer.disconnect();
        });
    });

    const scrollBy = (direction: -1 | 1) => {
        scrollRef?.scrollBy({ left: direction * SCROLL_STEP, behavior: "smooth" });
    };

    return (
        <div class="relative h-full border-t border-slate-700/50 bg-slate-900/50">
            <div class="flex h-full flex-col">
                <div class="flex items-center justify-between px-4 pt-3">
                    <div class="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Scenario Lanes
                    </div>
                    <Show when={hasScenarios()}>
                        <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">
                            {props.scenarios.length} scenarios
                        </div>
                    </Show>
                </div>

                <div
                    ref={scrollRef}
                    class="custom-scrollbar flex flex-1 gap-4 overflow-x-auto p-4"
                    style={{ "scroll-snap-type": "x proximity" }}
                >
                    <Show when={showSkeletons()}>
                        <For each={[0, 1, 2]}>
                            {() => (
                                <div class="w-[300px] flex-shrink-0 animate-pulse rounded-lg border border-slate-700/50 bg-slate-800/50 p-4">
                                    <div class="mb-2 h-4 w-32 rounded bg-slate-700/50" />
                                    <div class="mb-3 h-3 w-48 rounded bg-slate-700/30" />
                                    <div class="mb-2 flex items-center gap-1">
                                        <div class="h-7 w-7 rounded-full bg-slate-700/50" />
                                        <div class="mx-1 h-5 w-px bg-slate-700/30" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/50" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/50" />
                                        <div class="mx-1 h-5 w-px bg-slate-700/30" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/50" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/50" />
                                    </div>
                                    <div class="flex items-center gap-1">
                                        <div class="h-7 w-7 rounded-full bg-slate-700/30" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/30" />
                                        <div class="mx-1 h-5 w-px bg-slate-700/30" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/30" />
                                        <div class="mx-1 h-5 w-px bg-slate-700/30" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/30" />
                                        <div class="mx-1 h-5 w-px bg-slate-700/30" />
                                        <div class="h-7 w-7 rounded-full bg-slate-700/30" />
                                    </div>
                                </div>
                            )}
                        </For>
                    </Show>

                    <Show when={hasScenarios()}>
                        <For each={props.scenarios}>
                            {(scenario, index) => (
                                <div style={{ "scroll-snap-align": "start" }}>
                                    <ScenarioCard
                                        scenario={scenario}
                                        isSelected={props.selectedIndex === index()}
                                        onClick={() => props.onSelectScenario(index())}
                                    />
                                </div>
                            )}
                        </For>
                    </Show>

                    <Show when={!hasScenarios() && !showSkeletons()}>
                        <div class="flex h-full min-w-full items-center justify-center rounded-lg border border-dashed border-slate-700/50 bg-slate-800/40 text-sm text-slate-500">
                            Waiting for scenario output
                        </div>
                    </Show>
                </div>
            </div>

            <Show when={canScrollLeft()}>
                <button
                    type="button"
                    class="absolute bottom-0 left-0 top-0 z-10 flex w-8 items-center justify-center bg-gradient-to-r from-slate-900/80 to-transparent transition-opacity hover:from-slate-900"
                    onClick={() => scrollBy(-1)}
                >
                    <svg class="h-5 w-5 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                        <path
                            fill-rule="evenodd"
                            d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                            clip-rule="evenodd"
                        />
                    </svg>
                </button>
            </Show>
            <Show when={canScrollRight()}>
                <button
                    type="button"
                    class="absolute bottom-0 right-0 top-0 z-10 flex w-8 items-center justify-center bg-gradient-to-l from-slate-900/80 to-transparent transition-opacity hover:from-slate-900"
                    onClick={() => scrollBy(1)}
                >
                    <svg class="h-5 w-5 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                        <path
                            fill-rule="evenodd"
                            d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                            clip-rule="evenodd"
                        />
                    </svg>
                </button>
            </Show>
        </div>
    );
};

export default ScenarioLanes;
