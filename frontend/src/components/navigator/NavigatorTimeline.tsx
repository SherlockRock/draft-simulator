import { Component, For, Show, createMemo } from "solid-js";
import type { NavigatorEventData } from "../../contexts/NavigatorContext";
import { getChampionImg } from "../../utils/championRoles";
import { resolveChampion } from "../../utils/constants";
import { TURN_SEQUENCE, turnLabel } from "../../utils/turnSequence";

export interface NavigatorTimelineProps {
    /** Confirmed (ban/pick) events in slot order. */
    events: NavigatorEventData[];
    /** Slot the palette would fill; null when the draft is complete or read-only. */
    nextSlot: number | null;
    ourSide: "blue" | "red";
    readOnly: boolean;
    gapText: { blue: string; red: string };
    /** Receives the next-slot button so the palette can anchor under it. */
    onNextSlotClick: (el: HTMLButtonElement) => void;
}

/** Separators after slots 5, 11 and 15 (design § 1): before 6, 12, 16. */
const SEPARATOR_BEFORE = new Set([6, 12, 16]);

const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;

/** Design § 1 timeline row: 20 slots in TURN_SEQUENCE order, confirmed slots as
 *  portraits (bans muted with a slash), the next slot glowing and labelled, the
 *  role-gap strip right-aligned. */
export const NavigatorTimeline: Component<NavigatorTimelineProps> = (props) => {
    const bySlot = createMemo(() => {
        const map = new Map<number, NavigatorEventData>();
        for (const e of props.events) map.set(e.slot, e);
        return map;
    });
    return (
        <div class="flex items-center gap-1 border-b border-darius-border/60 bg-darius-bg px-4 py-2">
            <For each={TURN_SEQUENCE}>
                {(turn, i) => {
                    const ev = () => bySlot().get(i());
                    const isNext = () => !props.readOnly && props.nextSlot === i();
                    const sideBorder =
                        turn.side === "blue" ? "border-blue-400" : "border-red-400";
                    return (
                        <>
                            <Show when={SEPARATOR_BEFORE.has(i())}>
                                <span class="mx-1 h-6 w-px bg-darius-border" />
                            </Show>
                            <Show
                                when={ev()}
                                fallback={
                                    <Show
                                        when={isNext()}
                                        fallback={
                                            <span
                                                data-timeline-slot={i()}
                                                data-filled="false"
                                                title={turnLabel(i())}
                                                class={`h-7 w-7 rounded-full border-2 border-dashed opacity-60 ${turn.side === "blue" ? "border-blue-400/60" : "border-red-400/60"}`}
                                            />
                                        }
                                    >
                                        <button
                                            type="button"
                                            data-timeline-slot={i()}
                                            data-filled="false"
                                            data-next-slot="true"
                                            aria-label={turnLabel(i())}
                                            title={`${turnLabel(i())} — click to pick`}
                                            onClick={(e) =>
                                                props.onNextSlotClick(e.currentTarget)
                                            }
                                            class="relative h-7 w-7 cursor-pointer rounded-full border-2 border-sky-300 shadow-[0_0_0_3px_rgba(125,211,252,0.35)]"
                                        >
                                            <span class="absolute left-1/2 top-8 -translate-x-1/2 whitespace-nowrap text-[10px] text-sky-300">
                                                {turnLabel(i())}
                                            </span>
                                        </button>
                                    </Show>
                                }
                            >
                                {(e) => (
                                    <span
                                        data-timeline-slot={i()}
                                        data-filled="true"
                                        data-ban={
                                            e().event_type === "ban" ? "true" : "false"
                                        }
                                        title={`${turnLabel(i())}: ${nameOf(e().champion_id)}`}
                                        class="relative inline-block h-7 w-7"
                                    >
                                        <img
                                            src={getChampionImg(e().champion_id)}
                                            alt={nameOf(e().champion_id)}
                                            draggable={false}
                                            class={`h-full w-full rounded-full border-2 object-cover ${sideBorder} ${e().event_type === "ban" ? "opacity-50 grayscale" : ""}`}
                                        />
                                        <Show when={e().event_type === "ban"}>
                                            <span
                                                class={`absolute left-1 right-1 top-1/2 h-0.5 -rotate-45 ${turn.side === "blue" ? "bg-blue-300" : "bg-red-400"}`}
                                            />
                                        </Show>
                                    </span>
                                )}
                            </Show>
                        </>
                    );
                }}
            </For>
            <div
                data-role-gap
                class="ml-auto flex items-center gap-3 pl-4 text-xs text-slate-300"
            >
                <span data-role-gap-side="red">
                    <b class="text-red-300">Red needs</b> {props.gapText.red}
                </span>
                <span data-role-gap-side="blue">
                    <b class="text-blue-300">Blue needs</b> {props.gapText.blue}
                </span>
            </div>
        </div>
    );
};
