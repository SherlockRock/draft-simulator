import { Component, For, Show } from "solid-js";
import { ArrowLeftRight } from "lucide-solid";
import type { CanvasGroup } from "../utils/schemas";
import type { CardLayout } from "../utils/canvasCardLayout";
import {
    cellToPosition,
    footprintPixelSize,
    type GridCell,
    type GridFootprint
} from "../utils/gridLayout";

/** A landing (or displaced) rectangle: a top-left cell plus how far it spans. */
export type GridDropRect = { cell: GridCell; footprint: GridFootprint };

export type GridDropTarget = {
    groupId: string;
    landing: GridDropRect;
    isSwap: boolean;
    displaced: GridDropRect | null;
};

type GridDropHighlightProps = {
    group: CanvasGroup;
    target: GridDropTarget;
    cardLayout: () => CardLayout;
};

type HighlightKind = "landing" | "swap-target" | "swap-displaced";

/**
 * The grid drop affordance, painted at the WORLD level rather than inside the
 * target container (design §12).
 *
 * A container is `z-20` and carries a transform, so it is its own stacking
 * context: an overlay inside it can never paint above a NESTED container, which
 * is `z-20` in the same context and later in paint order. Hoisting it into
 * `.canvas-world` at `z-40` escapes that.
 *
 * The cost, accepted: it now also paints above the connection SVG. It is a
 * transient drag affordance, visible only while the pointer is down.
 *
 * Cells are converted to world space here — `group.position + cellToPosition`.
 * That is exactly equivalent to the group-local overlay it replaces, because
 * `cellToPosition` already includes the container's header and padding.
 */
export const GridDropHighlight: Component<GridDropHighlightProps> = (props) => {
    const rects = (): { rect: GridDropRect; kind: HighlightKind }[] => {
        const out: { rect: GridDropRect; kind: HighlightKind }[] = [
            {
                rect: props.target.landing,
                kind: props.target.isSwap ? "swap-target" : "landing"
            }
        ];
        if (props.target.displaced) {
            out.push({ rect: props.target.displaced, kind: "swap-displaced" });
        }
        return out;
    };

    return (
        <div class="pointer-events-none absolute left-0 top-0 z-40 h-0 w-0">
            <For each={rects()}>
                {(entry) => {
                    const layout = props.cardLayout();
                    const origin = cellToPosition(entry.rect.cell, layout);
                    const size = footprintPixelSize(entry.rect.footprint, layout);
                    return (
                        <div
                            class="absolute rounded-lg border-2"
                            classList={{
                                "border-darius-purple-bright bg-darius-purple-bright/10":
                                    entry.kind === "landing",
                                "border-darius-ember bg-darius-ember/10":
                                    entry.kind === "swap-target",
                                "border-dashed border-darius-ember/70 bg-darius-ember/5":
                                    entry.kind === "swap-displaced"
                            }}
                            style={{
                                left: `${props.group.positionX + origin.x}px`,
                                top: `${props.group.positionY + origin.y}px`,
                                width: `${size.width}px`,
                                height: `${size.height}px`
                            }}
                        >
                            <Show when={entry.kind === "swap-target"}>
                                <div class="absolute right-1.5 top-1.5 rounded-full border border-darius-ember/60 bg-darius-bg/90 p-1 text-darius-ember">
                                    <ArrowLeftRight size={14} />
                                </div>
                            </Show>
                        </div>
                    );
                }}
            </For>
        </div>
    );
};
