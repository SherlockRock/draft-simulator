import { Component, For, Show } from "solid-js";
import { Pin } from "lucide-solid";
import { resolveChampion } from "../utils/constants";
import BlankSquare from "/src/assets/BlankSquare.webp";
import type { SearchRowModel } from "../utils/searchRowModel";

/** picks[] layout: 0-4 blue bans, 5-9 red bans, 10-14 blue picks, 15-19 red picks. */
const BLUE_BAN_BASE = 0;
const RED_BAN_BASE = 5;
const BLUE_PICK_BASE = 10;
const RED_PICK_BASE = 15;

/** Offsets within one side's 5-slot block. Ban round 1 is 3 bans, round 2 is 2. */
const BAN_ROUNDS = [
    [0, 1, 2],
    [3, 4]
];
/** Draft-order pick groups: first-pick side goes 1 / 2+3 / 4+5 … */
const FIRST_PICK_GROUPS = [[0], [1, 2], [3, 4]];
/** …and the other side 1+2 / 3 / 4 / 5. */
const SECOND_PICK_GROUPS = [[0, 1], [2], [3], [4]];

/**
 * Fluid slots: every icon is flex-1 with a 28px floor (the row never renders
 * smaller than its fixed-size layout did) and a 40px ceiling. The cap lives on
 * the GROUP (count * max + internal gaps) so once icons stop growing the
 * group's underline still ends exactly at its last icon.
 */
const SLOT_MAX_PX = 40;
const SLOT_GAP_PX = 2;
const groupMaxWidth = (count: number): string =>
    `${count * SLOT_MAX_PX + (count - 1) * SLOT_GAP_PX}px`;

type SearchResultRowProps = {
    row: SearchRowModel;
    selected: boolean;
    pinned: boolean;
    onJump: (draftId: string) => void;
    onTogglePin: (draftId: string) => void;
};

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const SlotIcon: Component<{
    pick: string;
    highlight: "pick" | "ban" | null;
    variant: "pick" | "ban";
}> = (props) => {
    const champ = () =>
        props.pick !== "" ? (resolveChampion(props.pick) ?? null) : null;
    return (
        // The ring sits on a wrapper, not the img: `grayscale`/`opacity` on the
        // img would desaturate the ring with it, and a matched ban should read
        // as a knocked-out icon inside a full-colour crimson ring.
        <div
            class="aspect-square min-w-7 flex-1 rounded"
            classList={{
                "ring-2 ring-darius-ember/90": props.highlight === "pick",
                "ring-2 ring-darius-crimson/90": props.highlight === "ban"
            }}
        >
            <img
                src={champ()?.img ?? BlankSquare}
                alt={champ()?.name ?? "empty"}
                loading="lazy"
                class="h-full w-full rounded"
                classList={{
                    "grayscale opacity-75": props.variant === "ban" && champ() !== null,
                    "opacity-50": champ() === null
                }}
            />
        </div>
    );
};

/**
 * One complete draft (design decision 4): all 20 slots always visible, never
 * compromised to fit the panel. One column per physical side (blue | red):
 * grayed bans on top split by ban round, picks below with one shared underline
 * per draft-order pick group — the grouping flips with the game's firstPick.
 */
export const SearchResultRow: Component<SearchResultRowProps> = (props) => {
    const banSide = (base: number) => (
        <div class="flex items-center justify-between gap-2">
            <For each={BAN_ROUNDS}>
                {(round) => (
                    <div
                        class="flex min-w-0 basis-0 items-center gap-0.5"
                        style={{
                            "flex-grow": String(round.length),
                            "max-width": groupMaxWidth(round.length)
                        }}
                    >
                        <For each={round}>
                            {(offset) => (
                                <SlotIcon
                                    pick={props.row.picks[base + offset] ?? ""}
                                    highlight={
                                        props.row.matchedSlots[base + offset] ?? null
                                    }
                                    variant="ban"
                                />
                            )}
                        </For>
                    </div>
                )}
            </For>
        </div>
    );

    const pickSide = (base: number, side: "blue" | "red") => (
        <div class="flex justify-between gap-1.5">
            <For
                each={
                    props.row.firstPick === side ? FIRST_PICK_GROUPS : SECOND_PICK_GROUPS
                }
            >
                {(group) => {
                    return (
                        <div
                            class="flex min-w-0 basis-0 gap-0.5 border-b-2 pb-1"
                            style={{
                                "flex-grow": String(group.length),
                                "max-width": groupMaxWidth(group.length)
                            }}
                            classList={{
                                "border-sky-400/50": side === "blue",
                                "border-red-400/50": side === "red"
                            }}
                        >
                            <For each={group}>
                                {(offset) => (
                                    <SlotIcon
                                        pick={props.row.picks[base + offset] ?? ""}
                                        highlight={
                                            props.row.matchedSlots[base + offset] ?? null
                                        }
                                        variant="pick"
                                    />
                                )}
                            </For>
                        </div>
                    );
                }}
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
            <div class="mt-1.5 flex items-stretch gap-2">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                    {banSide(BLUE_BAN_BASE)}
                    {pickSide(BLUE_PICK_BASE, "blue")}
                </div>
                <div class="w-px self-stretch bg-darius-border" />
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                    {banSide(RED_BAN_BASE)}
                    {pickSide(RED_PICK_BASE, "red")}
                </div>
            </div>
        </div>
    );
};
