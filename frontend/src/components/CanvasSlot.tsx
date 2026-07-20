import { Component, Show, createMemo } from "solid-js";
import { X } from "lucide-solid";
import { getSplashUrl, resolveChampion } from "../utils/constants";
import type { SlotPhase } from "../utils/canvasSearch";
import BlankSquare from "/src/assets/BlankSquare.webp";

export type SlotDisplayMode = "full" | "compact" | "wide-art";

type CanvasSlotProps = {
    /** Champion id ("" = empty). Legacy name values resolve via resolveChampion. */
    pick: string;
    label: string;
    displayMode?: SlotDisplayMode;
    side?: "team1" | "team2";
    disabled: boolean;
    /** This slot is the picker's current advance target. */
    isPickerTarget: boolean;
    /** Search match highlight; picks and bans styled distinctly. */
    searchHighlight?: SlotPhase | null;
    onOpen: () => void;
    onClear: () => void;
};

export const CanvasSlot: Component<CanvasSlotProps> = (props) => {
    const isCompact = createMemo(() => props.displayMode === "compact");
    const isWideArt = createMemo(() => props.displayMode === "wide-art");

    const selectedChampion = createMemo(() =>
        props.pick !== "" ? (resolveChampion(props.pick) ?? null) : null
    );

    const retryChampionImage = (e: Event & { currentTarget: HTMLImageElement }) => {
        const img = e.currentTarget;
        if (img.dataset.retried === "true") return;
        img.dataset.retried = "true";
        const src = img.src;
        window.setTimeout(() => {
            img.src = "";
            img.src = src;
        }, 1500);
    };

    const openSlot = () => {
        if (!props.disabled) props.onOpen();
    };

    const clear = (e: MouseEvent) => {
        e.stopPropagation();
        props.onClear();
    };

    const stopMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    return (
        <div
            data-canvas-slot-root="true"
            class="relative flex min-h-0 w-full min-w-0"
            classList={{
                "h-full flex-1": !isCompact(),
                "cursor-not-allowed": props.disabled
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <Show
                when={isCompact()}
                fallback={
                    <Show
                        when={isWideArt()}
                        fallback={
                            /* ---- full ---- */
                            <div
                                class="flex h-full min-h-0 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-darius-bg px-2 py-1 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                                onClick={openSlot}
                                classList={{
                                    "border-darius-border":
                                        !props.isPickerTarget && !props.searchHighlight,
                                    "cursor-pointer hover:border-darius-purple-bright/60":
                                        !props.disabled,
                                    "border-darius-ember/70 ring-2 ring-darius-ember":
                                        props.isPickerTarget,
                                    "border-darius-ember/80 ring-2 ring-darius-ember/90":
                                        !props.isPickerTarget &&
                                        props.searchHighlight === "pick",
                                    "border-darius-crimson/80 ring-2 ring-darius-crimson/90":
                                        !props.isPickerTarget &&
                                        props.searchHighlight === "ban",
                                    "opacity-60": props.disabled
                                }}
                            >
                                <div
                                    class="flex min-w-0 flex-1 items-center gap-2"
                                    classList={{
                                        "flex-row-reverse": props.side === "team2"
                                    }}
                                >
                                    <Show
                                        when={selectedChampion()}
                                        fallback={
                                            <img
                                                src={BlankSquare}
                                                alt="blank"
                                                class="h-6 w-6 shrink-0 rounded-md opacity-70"
                                            />
                                        }
                                    >
                                        {(champ) => (
                                            <img
                                                src={champ().img}
                                                alt={champ().name}
                                                class="h-6 w-6 shrink-0 rounded-md"
                                                onError={retryChampionImage}
                                            />
                                        )}
                                    </Show>
                                    <div
                                        class="h-6 min-w-0 flex-1 truncate px-1 leading-6"
                                        classList={{
                                            "text-right": props.side === "team2",
                                            "text-darius-text-primary":
                                                selectedChampion() !== null,
                                            "text-darius-text-secondary":
                                                selectedChampion() === null
                                        }}
                                    >
                                        {selectedChampion()?.name ?? props.label}
                                    </div>
                                </div>
                                <Show
                                    when={selectedChampion() !== null && !props.disabled}
                                >
                                    <button
                                        type="button"
                                        onMouseDown={stopMouseDown}
                                        onClick={clear}
                                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-darius-text-primary transition-all hover:text-darius-purple-bright"
                                        classList={{
                                            "order-first": props.side === "team2"
                                        }}
                                        aria-label={`Clear ${props.label}`}
                                    >
                                        <X size={16} />
                                    </button>
                                </Show>
                            </div>
                        }
                    >
                        {/* ---- wide-art ---- */}
                        <div class="relative flex h-full min-h-0 w-full flex-1">
                            <div
                                class="relative flex h-full min-h-0 w-full flex-1 items-end overflow-hidden rounded-xl border-2 bg-darius-bg text-left transition-all"
                                onClick={openSlot}
                                classList={{
                                    "border-darius-border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]":
                                        !props.isPickerTarget && !props.searchHighlight,
                                    "cursor-pointer hover:shadow-[0_12px_30px_rgba(0,0,0,0.3)]":
                                        !props.disabled,
                                    "border-darius-ember/70 ring-2 ring-darius-ember":
                                        props.isPickerTarget,
                                    "border-darius-ember/80 ring-2 ring-darius-ember/90":
                                        !props.isPickerTarget &&
                                        props.searchHighlight === "pick",
                                    "border-darius-crimson/80 ring-2 ring-darius-crimson/90":
                                        !props.isPickerTarget &&
                                        props.searchHighlight === "ban",
                                    "opacity-60": props.disabled
                                }}
                            >
                                <div class="absolute inset-0 bg-darius-bg" />
                                <Show when={selectedChampion()}>
                                    {(champ) => (
                                        <img
                                            src={getSplashUrl(champ().name)}
                                            alt={champ().name}
                                            class="absolute -inset-2 block h-[calc(100%+1rem)] w-[calc(100%+1rem)] max-w-none object-cover object-[center_25%]"
                                            onError={retryChampionImage}
                                            classList={{
                                                "-translate-x-[15%] scale-[1.25]":
                                                    props.side === "team1",
                                                "translate-x-[15%] scale-[1.25]":
                                                    props.side === "team2"
                                            }}
                                        />
                                    )}
                                </Show>
                                <div class="absolute inset-0 bg-darius-bg/35" />
                                <div
                                    class="relative z-[3] flex w-full items-end px-3 py-2"
                                    classList={{
                                        "flex-row-reverse": props.side === "team2"
                                    }}
                                >
                                    <div
                                        class="min-w-0 truncate drop-shadow-lg"
                                        classList={{
                                            "text-right": props.side === "team2",
                                            "text-base font-semibold tracking-wide text-darius-text-primary":
                                                selectedChampion() !== null,
                                            "text-sm font-semibold uppercase tracking-[0.2em] text-darius-text-secondary":
                                                selectedChampion() === null
                                        }}
                                    >
                                        {selectedChampion()?.name ?? props.label}
                                    </div>
                                </div>
                            </div>
                            <Show when={selectedChampion() !== null && !props.disabled}>
                                <button
                                    type="button"
                                    onMouseDown={stopMouseDown}
                                    onClick={clear}
                                    class="absolute right-2 top-2 z-[4] flex h-5 w-5 items-center justify-center rounded-full border border-darius-border/80 bg-darius-bg/85 bg-darius-card text-darius-text-primary"
                                    aria-label={`Clear ${props.label}`}
                                >
                                    <X size={12} />
                                </button>
                            </Show>
                        </div>
                    </Show>
                }
            >
                {/* ---- compact ---- */}
                <div class="relative">
                    <div
                        class="relative flex h-[30px] w-[30px] items-center justify-center overflow-hidden rounded-lg border bg-darius-bg p-[2px]"
                        onClick={openSlot}
                        classList={{
                            "border-darius-border/80":
                                !props.isPickerTarget && !props.searchHighlight,
                            "cursor-pointer": !props.disabled,
                            "border-darius-ember/70 ring-2 ring-darius-ember":
                                props.isPickerTarget,
                            "border-darius-ember/80 ring-2 ring-darius-ember/90":
                                !props.isPickerTarget && props.searchHighlight === "pick",
                            "border-darius-crimson/80 ring-2 ring-darius-crimson/90":
                                !props.isPickerTarget && props.searchHighlight === "ban",
                            "opacity-60": props.disabled
                        }}
                    >
                        <Show
                            when={selectedChampion()}
                            fallback={
                                <img
                                    src={BlankSquare}
                                    alt="blank"
                                    class="h-full w-full rounded-md object-cover opacity-70"
                                />
                            }
                        >
                            {(champ) => (
                                <img
                                    src={champ().img}
                                    alt={champ().name}
                                    class="h-full w-full rounded-md object-cover"
                                    onError={retryChampionImage}
                                />
                            )}
                        </Show>
                    </div>
                    <Show when={selectedChampion() !== null && !props.disabled}>
                        <button
                            type="button"
                            onMouseDown={stopMouseDown}
                            onClick={clear}
                            class="absolute -right-1 -top-1 z-[3] flex h-3.5 w-3.5 items-center justify-center rounded-full border border-darius-border/80 bg-darius-bg bg-darius-card-hover text-darius-text-primary shadow-sm"
                            aria-label={`Clear ${props.label}`}
                        >
                            <X size={10} />
                        </button>
                    </Show>
                </div>
            </Show>
        </div>
    );
};
