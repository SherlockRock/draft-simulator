import { Component, For, Show } from "solid-js";
import { TURN_SEQUENCE, turnLabel } from "../../utils/turnSequence";

/** Separators after slots 5, 11 and 15 (design § 1): before 6, 12, 16. */
const SEPARATOR_BEFORE = new Set([6, 12, 16]);

/** Design § 1: the header's 20-tick draft-order bar — side-coloured, the next slot highlighted.
 *  It replaces the timeline row; the team columns carry the champions. */
export const DraftOrderTicks: Component<{
    filledCount: number;
    nextSlot: number | null;
}> = (props) => {
    const state = (i: number): "filled" | "next" | "empty" =>
        i < props.filledCount ? "filled" : i === props.nextSlot ? "next" : "empty";
    return (
        <span
            data-draft-order-ticks
            class="flex items-center gap-[3px]"
            aria-label="Draft order"
        >
            <For each={TURN_SEQUENCE}>
                {(turn, i) => (
                    <>
                        <Show when={SEPARATOR_BEFORE.has(i())}>
                            <span
                                data-tick-separator
                                class="mx-0.5 h-2.5 w-px bg-darius-border"
                            />
                        </Show>
                        <i
                            data-tick={i()}
                            data-tick-side={turn.side}
                            data-tick-state={state(i())}
                            title={turnLabel(i())}
                            class={`block h-[5px] w-2.5 rounded-sm ${
                                state(i()) === "next"
                                    ? "bg-sky-300 shadow-[0_0_0_2px_rgba(125,211,252,0.35)]"
                                    : state(i()) === "filled"
                                      ? turn.side === "blue"
                                          ? "bg-blue-400"
                                          : "bg-red-400"
                                      : "bg-slate-700"
                            }`}
                        />
                    </>
                )}
            </For>
        </span>
    );
};
