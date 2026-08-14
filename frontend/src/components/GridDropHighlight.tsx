import { Component, For, Show } from "solid-js";
import { ArrowLeftRight } from "lucide-solid";
import type { CanvasGroup } from "../utils/schemas";
import type { CardLayout } from "../utils/canvasCardLayout";
import {
    cellToPosition,
    footprintPixelWidth,
    type GridCell,
    type GridFootprint
} from "../utils/gridLayout";
import { spannedBandHeight, type RowMetrics } from "../utils/gridRows";

/**
 * A landing (or displaced) rectangle: a top-left cell, how far it spans, and
 * the ROW BAND it lands in.
 *
 * `rowMetrics` must be the LANDING metrics — the row as it will be once the
 * drop completes, computed from projected membership — not the targeting ones.
 * Dragging a Bo3 into a grid is precisely the gesture whose point is that the
 * row grows to fit it, so a highlight drawn one card tall at a Card's offset
 * would mispromise exactly the thing §6.0a ships.
 *
 * `rows` is that same projected model, needed because a footprint spanning rows
 * is taller than the band it starts in.
 */
export type GridDropRect = {
    cell: GridCell;
    footprint: GridFootprint;
    rowMetrics: RowMetrics;
    rows: RowMetrics[];
};

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
 * Rects are converted to world space here — `group.position` plus the column
 * lattice for x, plus the row band's own offset for y. That is exactly
 * equivalent to the group-local overlay it replaces, because both already
 * include the container's header and padding.
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
                    // x from the column lattice, y and height from the row
                    // BAND — the two axes have different inverses now.
                    const left = cellToPosition(entry.rect.cell, layout).x;
                    const width = footprintPixelWidth(entry.rect.footprint, layout);
                    const band = entry.rect.rowMetrics;
                    // The full spanned band, not just the row it starts in —
                    // otherwise a two-row note promises a one-row landing.
                    const height = spannedBandHeight(
                        entry.rect.rows,
                        band,
                        entry.rect.footprint.rows,
                        layout
                    );
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
                                left: `${props.group.positionX + left}px`,
                                top: `${props.group.positionY + band.offset}px`,
                                width: `${width}px`,
                                height: `${height}px`
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
