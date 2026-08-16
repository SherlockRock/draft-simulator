import { Component, For, Show } from "solid-js";
import { Pin } from "lucide-solid";
import { resolveChampion } from "../utils/constants";
import BlankSquare from "/src/assets/BlankSquare.webp";
import type { SearchRowModel } from "../utils/searchRowModel";

/** picks[] layout: 0-4 blue bans, 5-9 red bans, 10-14 blue picks, 15-19 red picks. */
const BAN_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const PICK_INDICES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

type SearchResultRowProps = {
    row: SearchRowModel;
    selected: boolean;
    pinned: boolean;
    onJump: (draftId: string) => void;
    onTogglePin: (draftId: string) => void;
};

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const SlotIcon: Component<{ pick: string; highlight: "pick" | "ban" | null }> = (
    props
) => {
    const champ = () =>
        props.pick !== "" ? (resolveChampion(props.pick) ?? null) : null;
    return (
        <img
            src={champ()?.img ?? BlankSquare}
            alt={champ()?.name ?? "empty"}
            loading="lazy"
            class="size-6 shrink-0 rounded"
            classList={{
                "opacity-50": champ() === null,
                "ring-2 ring-darius-ember/90": props.highlight === "pick",
                "ring-2 ring-darius-crimson/90": props.highlight === "ban"
            }}
        />
    );
};

/**
 * One complete draft (design decision 4): all 20 slots always visible, never
 * compromised to fit the panel. Two strips — bans over picks — each split
 * blue | red, mirroring the card's physical sides.
 */
export const SearchResultRow: Component<SearchResultRowProps> = (props) => {
    const strip = (indices: number[]) => (
        <div class="flex items-center gap-0.5">
            <For each={indices.slice(0, 5)}>
                {(index) => (
                    <SlotIcon
                        pick={props.row.picks[index] ?? ""}
                        highlight={props.row.matchedSlots[index] ?? null}
                    />
                )}
            </For>
            <div class="w-2" />
            <For each={indices.slice(5)}>
                {(index) => (
                    <SlotIcon
                        pick={props.row.picks[index] ?? ""}
                        highlight={props.row.matchedSlots[index] ?? null}
                    />
                )}
            </For>
        </div>
    );

    return (
        <div
            data-row-draft-id={props.row.draftId}
            onClick={() => props.onJump(props.row.draftId)}
            class="mt-2 cursor-pointer rounded-lg border bg-darius-bg/60 p-2 transition-colors"
            classList={{
                "border-darius-purple-bright ring-1 ring-darius-purple-bright":
                    props.selected,
                "border-darius-border hover:border-darius-purple-bright/60":
                    !props.selected
            }}
        >
            <div class="flex items-center gap-2 text-xs">
                <Show when={props.row.teamSide}>
                    {(side) => (
                        <span
                            title={side() === "blue" ? "Blue side" : "Red side"}
                            class="size-2 shrink-0 rounded-full"
                            classList={{
                                "bg-sky-400": side() === "blue",
                                "bg-red-400": side() === "red"
                            }}
                        />
                    )}
                </Show>
                <Show when={props.row.outcome}>
                    {(outcome) => (
                        <span
                            class="font-bold"
                            classList={{
                                "text-emerald-400": outcome() === "win",
                                "text-darius-crimson": outcome() === "loss",
                                "text-darius-text-secondary": outcome() === "noResult"
                            }}
                        >
                            {outcome() === "win" ? "W" : outcome() === "loss" ? "L" : "–"}
                        </span>
                    )}
                </Show>
                <span class="min-w-0 truncate font-semibold text-darius-text-primary">
                    {props.row.leftTeam ?? "—"} vs {props.row.rightTeam ?? "—"}
                </span>
                <Show when={props.row.inProgress}>
                    <span class="shrink-0 text-darius-ember">in progress</span>
                </Show>
                <span class="ml-auto shrink-0 truncate text-darius-text-secondary">
                    {props.row.label}
                </span>
                <Show when={props.row.date}>
                    {(date) => (
                        <span class="shrink-0 text-darius-text-secondary">
                            {formatDate(date())}
                        </span>
                    )}
                </Show>
                <button
                    type="button"
                    aria-label={props.pinned ? "Unpin row" : "Pin row"}
                    onClick={(e) => {
                        e.stopPropagation();
                        props.onTogglePin(props.row.draftId);
                    }}
                    class="shrink-0 rounded p-0.5 transition-colors"
                    classList={{
                        "text-darius-purple-bright": props.pinned,
                        "text-darius-text-secondary hover:text-darius-text-primary":
                            !props.pinned
                    }}
                >
                    <Pin size={14} fill={props.pinned ? "currentColor" : "none"} />
                </button>
            </div>
            <div class="mt-1.5 flex flex-col gap-1">
                {strip(BAN_INDICES)}
                {strip(PICK_INDICES)}
            </div>
        </div>
    );
};
