import { Component, For, Show, createMemo } from "solid-js";
import { resolveChampion } from "../utils/constants";
import type { SlotPhase } from "../utils/canvasSearch";
import BlankSquare from "/src/assets/BlankSquare.webp";

/**
 * The low-zoom rendering of a card's interior: a flat grid of champion icons.
 *
 * Below `LOD_ENTER_ZOOM` a card is ~210px wide and each of its 20 wide-art slots
 * renders at roughly 105x26px, where the champion name is under 5px tall and the
 * borders, radii, shadows and 1.25x splash transform are all sub-pixel. This drops
 * every one of those and keeps only the thing that survives at that size — the icon
 * mosaic, which is what makes a draft recognisable while panning.
 *
 * ONE arrangement for every layout that uses it: 4 columns x 5, mirroring the
 * `horizontal` layout the app already ships — blue bans, blue picks, red picks,
 * red bans, with bans dimmed.
 *
 * `wide-draft-order` therefore does NOT keep its draft-order sequence down here, so
 * a tile is not always where that layout puts the same slot when zoomed in. That is
 * a deliberate call: one column per team in draft order needs 10 rows, which makes
 * each tile a 3.9:1 band that crops a square champion icon down to an unreadable
 * sliver, and squaring it up would need roughly double the card height. A single
 * predictable mosaic beat both alternatives.
 *
 * The slots are NOT unmounted while this is shown — see CanvasCard. Search matches
 * are drawn as overlays here rather than by the per-slot ring, deliberately heavier
 * than that ring because at this zoom a 2px border is a third of a device pixel.
 */

type CanvasCardMosaicProps = {
    picks: string[];
    searchSlotPhase?: (pickIndex: number) => SlotPhase | null;
    isPickerTarget: (pickIndex: number) => boolean;
};

const blueBans = [0, 1, 2, 3, 4];
const redBans = [5, 6, 7, 8, 9];
const bluePicks = [10, 11, 12, 13, 14];
const redPicks = [15, 16, 17, 18, 19];

const MOSAIC_COLUMNS = [
    { indices: blueBans, rail: "bg-darius-crimson/80" },
    { indices: bluePicks, rail: "bg-darius-ember/80" },
    { indices: redPicks, rail: "bg-darius-ember/80" },
    { indices: redBans, rail: "bg-darius-crimson/80" }
];

const MosaicTile: Component<{
    pick: string;
    phase: SlotPhase | null;
    isPickerTarget: boolean;
    dim: boolean;
}> = (props) => {
    const champion = createMemo(() => {
        if (props.pick === "") return null;
        return resolveChampion(props.pick) ?? null;
    });

    return (
        <div class="relative min-h-0 min-w-0 overflow-hidden bg-darius-bg">
            {/* Picks are NAMED rather than decorative: `visibility: hidden` takes the
                real slots out of the accessibility tree along with their alt text, so
                without a name here they have no accessible equivalent at low zoom. The
                empty placeholder stays decorative — an unfilled slot has nothing to
                announce, and naming it would put one for every gap on the canvas. */}
            <Show
                when={champion()}
                fallback={
                    <img
                        src={BlankSquare}
                        alt=""
                        class="h-full w-full object-cover opacity-70"
                    />
                }
            >
                {(champ) => (
                    <img
                        src={champ().img}
                        alt={champ().name}
                        class="h-full w-full object-cover"
                        classList={{ "opacity-50 saturate-50": props.dim }}
                    />
                )}
            </Show>
            <Show when={props.isPickerTarget || props.phase !== null}>
                <div
                    class="pointer-events-none absolute inset-0 z-[2] ring-[10px] ring-inset"
                    classList={{
                        "bg-darius-ember/25 ring-darius-ember":
                            props.isPickerTarget || props.phase === "pick",
                        "bg-darius-crimson/25 ring-darius-crimson":
                            !props.isPickerTarget && props.phase === "ban"
                    }}
                />
            </Show>
        </div>
    );
};

export const CanvasCardMosaic: Component<CanvasCardMosaicProps> = (props) => (
    <div class="flex h-full min-h-0 flex-col gap-1.5">
        <div class="grid h-2 shrink-0 grid-cols-4">
            <For each={MOSAIC_COLUMNS}>
                {(column) => <div class={`mx-px rounded-full ${column.rail}`} />}
            </For>
        </div>
        {/* auto-cols-fr: `grid-flow-col` creates IMPLICIT columns, which default to
            `auto` and would size to the champion icon's intrinsic width instead of
            splitting the card into four. */}
        <div class="grid min-h-0 flex-1 auto-cols-fr grid-flow-col grid-rows-5">
            <For each={MOSAIC_COLUMNS}>
                {(column) => (
                    <For each={column.indices}>
                        {(pickIndex) => (
                            <MosaicTile
                                pick={props.picks[pickIndex]}
                                phase={props.searchSlotPhase?.(pickIndex) ?? null}
                                isPickerTarget={props.isPickerTarget(pickIndex)}
                                dim={pickIndex < 10}
                            />
                        )}
                    </For>
                )}
            </For>
        </div>
    </div>
);
