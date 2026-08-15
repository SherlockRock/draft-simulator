import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { CanvasAnnotation as CanvasAnnotationRow } from "../utils/schemas";
import { resolveStripChampions } from "../utils/annotationStrip";
import { annotationSurfaceClass, ANNOTATION_FONT_PX } from "../utils/annotationStyle";
import { MIN_ANNOTATION_HEIGHT, MIN_ANNOTATION_WIDTH } from "../utils/annotationSize";
import { scaledStrokePx } from "../utils/viewport";
import { resizeFromLeft, resizeHandleWorldPx } from "../utils/resizeHandle";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";
import { ChampionPortrait } from "./ChampionPortrait";
import { ResizeGrip } from "./ResizeGrip";

export const annotationRenderTop = (positionY: number, isGrouped: boolean): number =>
    isGrouped ? positionY - CUSTOM_GROUP_HEADER_HEIGHT : positionY;

type CanvasAnnotationProps = {
    annotation: CanvasAnnotationRow;
    isGrouped: boolean;
    zoom: () => number;
    canEdit: () => boolean;
    isConnectionMode: boolean;
    snappedSize: () => { width: number; height: number } | null;
    isSelected: () => boolean;
    editingAnnotationId: () => string | null;
    onEditingComplete: () => void;
    /**
     * Enter inline edit. The component cannot do this itself: the textarea is
     * only mounted while editing, so at rest `textareaRef` is undefined and
     * focusing it is a no-op.
     */
    onStartEditing: (annotationId: string) => void;
    onMouseDown: (e: MouseEvent, annotation: CanvasAnnotationRow) => void;
    /**
     * True once this note's text is too small on screen to read (design §4).
     *
     * Supplied by the parent rather than computed here, and that is the whole
     * optimisation: the state machine depends only on the FONT PRESET and the
     * zoom, so Canvas keeps four of them and every note shares one. Computing
     * it per note would put a reactive node on every annotation for a value
     * that has four distinct answers.
     */
    isTextCollapsed: () => boolean;
    onAddChampion: (annotationId: string) => void;
    onRemoveChampion: (annotationId: string, championId: string) => void;
    onCommitText: (annotationId: string, text: string, measuredHeight: number) => void;
    /**
     * `isLeftEdge` says which corner is being dragged, and it is passed rather
     * than inferred on purpose. The receiver cannot recover it from the
     * numbers: comparing the incoming `positionX` against the stored one calls
     * a RIGHT-edge drag a left-edge one whenever the note's x has moved since
     * mousedown, and calls a left-edge drag a right-edge one at the exact
     * moment the user drags back to where they started.
     */
    onResize: (
        annotationId: string,
        positionX: number,
        width: number,
        height: number,
        isLeftEdge: boolean
    ) => void;
    onResizeEnd: (
        annotationId: string,
        positionX: number,
        width: number,
        height: number,
        isLeftEdge: boolean
    ) => void;
};

/**
 * Reset the element's height BEFORE reading `scrollHeight` (design D7).
 *
 * Without the reset, `scrollHeight` reports the CURRENT box whenever the
 * current box is the taller of the two, so the note grows and never shrinks —
 * and blur commits that stale height, permanently.
 */
const measureContentHeight = (el: HTMLTextAreaElement): number => {
    const restore = el.style.height;
    el.style.height = "0px";
    const measured = el.scrollHeight;
    el.style.height = restore;
    return measured;
};

export const CanvasAnnotation = (props: CanvasAnnotationProps) => {
    const [textSignal, setTextSignal] = createSignal(props.annotation.text);
    const [isTextFocused, setIsTextFocused] = createSignal(false);
    let textareaRef: HTMLTextAreaElement | undefined;

    // Both branches handled: when the store value changes under an unfocused
    // note we resync, and while focused we deliberately do not — that is the
    // whole reason the blur handler has to snapshot.
    createEffect(() => {
        const stored = props.annotation.text;
        if (!isTextFocused() && textSignal() !== stored) setTextSignal(stored);
    });

    createEffect(() => {
        if (props.editingAnnotationId() === props.annotation.id) {
            textareaRef?.focus();
            textareaRef?.select();
        }
    });

    const isEditing = () => props.editingAnnotationId() === props.annotation.id;

    // Snapped inside a grid, stored outside it (design D5a). Snapping happens
    // at RENDER and never at commit, so drag-into-grid then drag-back-out is a
    // lossless round trip rather than a silent resize.
    //
    // ⚠️ One exception, and it is deliberate: the resize handle SEEDS from
    // these, so a hand-resize inside a grid commits a snapped-derived size and
    // that note's round trip is no longer lossless. Only an explicit resize
    // does this — a note the user never resized still round-trips exactly.
    // See the resize handle below for why the alternative was worse.
    const renderWidth = () => props.snappedSize()?.width ?? props.annotation.width;
    const renderHeight = () => props.snappedSize()?.height ?? props.annotation.height;

    const fontPx = createMemo(() => ANNOTATION_FONT_PX[props.annotation.fontSize]);

    /**
     * Both bottom corners, which differ in exactly one thing: which horizontal
     * edge stays put. `se` pins the left edge and grows right; `sw` pins the
     * RIGHT edge and moves `positionX` as the width changes. Height is
     * identical for both — they are both BOTTOM corners.
     */
    const handleResizeMouseDown = (e: MouseEvent, corner: "sw" | "se") => {
        e.stopPropagation();
        const isLeftEdge = corner === "sw";
        const startX = e.clientX;
        const startY = e.clientY;
        // Seeded from the PAINTED box, not the stored size — and via the same
        // accessors that paint it, so the gesture's origin cannot drift from
        // the corner the handle is sitting on.
        //
        // Inside a grid those differ, and seeding from the stored size left the
        // handle detached from the number it controls: a 56px-stored note
        // painting 700px needed ~700px of travel before the first cell
        // appeared, and a 120px-stored note painting 384px beside a Card did
        // nothing for ~264px. The vertical dead zone's SIZE depended on what
        // else shared the row, which is what made the two axes feel unrelated.
        //
        // Captured once, deliberately. Re-reading them per mousemove would feed
        // each frame's snapped result back in as the next frame's origin.
        //
        // `positionX` is the exception that needs no render accessor: the note
        // paints at `left: positionX` verbatim, so stored and painted x are the
        // same number. Only the SIZE is ever snapped away from storage.
        const startPositionX = props.annotation.positionX;
        const startWidth = renderWidth();
        const startHeight = renderHeight();

        const onMove = (move: MouseEvent) => {
            const deltaX = (move.clientX - startX) / props.zoom();
            const deltaY = (move.clientY - startY) / props.zoom();
            // Clamped to the RESIZE MINIMUM, not to the manual floor — this
            // gesture is what SETS the floor, so reading it here would ratchet
            // the note's size up and make it un-shrinkable by hand.
            const horizontal = isLeftEdge
                ? resizeFromLeft({
                      startPositionX,
                      startWidth,
                      deltaX,
                      minWidth: MIN_ANNOTATION_WIDTH
                  })
                : {
                      // The LIVE x, not the captured one. This corner does not
                      // move the note, so it must not write a stale origin over
                      // an x that something else has since changed.
                      positionX: props.annotation.positionX,
                      width: Math.max(MIN_ANNOTATION_WIDTH, startWidth + deltaX)
                  };
            const height = Math.max(MIN_ANNOTATION_HEIGHT, startHeight + deltaY);
            props.onResize(
                props.annotation.id,
                horizontal.positionX,
                horizontal.width,
                height,
                isLeftEdge
            );
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            props.onResizeEnd(
                props.annotation.id,
                props.annotation.positionX,
                props.annotation.width,
                props.annotation.height,
                isLeftEdge
            );
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    /**
     * The strip's EDIT affordances (the `+` and the per-chip `×`).
     *
     * ⚠️ `!isConnectionMode` is load-bearing and is why this is one accessor
     * rather than the condition written out three times. Connection mode makes
     * a click on a note mean "wire this endpoint", and every other affordance
     * in this component already stands down for it — the drag cursor (:226),
     * the drag itself (:248) and the resize grips (:367). These two buttons
     * carry their own `onMouseDown` stopPropagation, so left ungated they do
     * not merely show: they SWALLOW the connection click and open a champion
     * picker instead.
     *
     * The chips themselves stay visible in connection mode. They are content,
     * not an affordance.
     */
    const canEditStrip = () =>
        props.isSelected() && props.canEdit() && !props.isConnectionMode;

    const commitText = () => {
        // ⚠️ Snapshot BEFORE clearing the focus flag. Solid flushes the resync
        // effect above SYNCHRONOUSLY on that write, which restores the OLD
        // store text into textSignal — so reading the signal afterwards hands
        // the commit the value it already had, and the equality check upstream
        // then bails silently. That was the whole draft-rename regression: no
        // request, no toast, the text reverts. Snapshotting makes the commit
        // independent of effect scheduling rather than dependent on statement
        // order (CanvasCard.tsx:721 carries the twin of this comment).
        const typed = textSignal();
        // Measured while the textarea is still auto-fit, for the same reason:
        // once the flag clears, the element re-renders at the stored height.
        const measured = textareaRef ? measureContentHeight(textareaRef) : 0;
        setIsTextFocused(false);
        props.onCommitText(props.annotation.id, typed, measured);
        props.onEditingComplete();
    };

    return (
        <div
            data-annotation-id={props.annotation.id}
            // `canvas-annotation` is REQUIRED: `dispatchContextMenu` in
            // Canvas.tsx matches on it to route the right-click to the
            // annotation menu.
            //
            // ⚠️ `class` here is a STATIC string and must stay static. A
            // reactive `class` alongside a reactive `classList` on the same
            // element is a real bug: Solid's `className()` does
            // `node.className = value` — a wholesale write that wipes every
            // class `classList` added — and `classList()` then skips re-adding
            // them because it diffs against its own `prev` map. The first
            // colour change would silently drop `cursor-grab` and the selection
            // ring, permanently.
            //
            // Multi-class classList keys are fine and are the house idiom
            // (CanvasCard.tsx:636, :746): Solid's `toggleClassKey` does
            // `key.trim().split(/\s+/)` and toggles each name.
            class="canvas-annotation absolute flex select-none flex-col overflow-hidden rounded-md border-2 transition-colors"
            classList={{
                [annotationSurfaceClass(props.annotation.color)]: true,
                "cursor-grab": props.canEdit() && !props.isConnectionMode,
                "ring-2 ring-darius-purple-bright": props.isSelected()
            }}
            style={{
                left: `${props.annotation.positionX}px`,
                top: `${annotationRenderTop(
                    props.annotation.positionY,
                    props.isGrouped
                )}px`,
                width: `${renderWidth()}px`,
                height: `${renderHeight()}px`,
                // `scaledStrokePx`, NOT `screenConstantPx`. viewport.ts:55-84
                // is explicit: constant on-screen size is for chrome that is
                // genuinely zoom-independent, and "reads as absurdly heavy when
                // the card it surrounds is 34px wide". A note's minimum width is
                // 56px, so screenConstantPx(2) at MIN_ZOOM would be ~20 world px
                // of border swallowing the whole box. This scales with the
                // content and holds at a floor instead of rasterising away.
                "border-width": `${scaledStrokePx(2, props.zoom())}px`
            }}
            onMouseDown={(e) => props.onMouseDown(e, props.annotation)}
            onDblClick={(e) => {
                if (!props.canEdit() || props.isConnectionMode) return;
                e.stopPropagation();
                // NOT `textareaRef?.focus()` — at rest the textarea is not
                // mounted, so the ref is undefined and that would silently do
                // nothing. Ask Canvas to set editingAnnotationId; the <Show>
                // below then mounts the textarea and the effect above focuses
                // it. §4 requires double-click to enter edit.
                props.onStartEditing(props.annotation.id);
            }}
        >
            {/* Collapsed to a bare colour block below the legibility floor
                (design §4). The surface keeps painting its colour and the
                champion strip below still renders — those read the note's
                presence and category at a glance, which is the whole
                affordance; the text at that size is a smear.

                ⚠️ Editing is EXEMPT, and deliberately so. Unmounting a focused
                textarea does not reliably fire `blur`, and `commitText` runs on
                blur — so collapsing mid-edit would drop whatever the user had
                typed. That is the same class of silent-loss bug as the
                draft-rename regression this component's commit path already
                carries a comment about. Zooming out far enough to collapse
                while editing is rare; losing the edit when it happens is not
                acceptable, and the exemption costs one condition.

                Because the size is STORED, this is paint-only and can never
                reflow anything. */}
            <Show when={!props.isTextCollapsed() || isEditing() || isTextFocused()}>
                <Show
                    when={isEditing() || isTextFocused()}
                    fallback={
                        <div
                            // `min-h-0 flex-1`, NOT `h-full`: the root is a flex
                            // column and the strip is its second row. `h-full` makes
                            // this child consume the whole content box, so the strip
                            // lays out BELOW the note's border and D3's "text above,
                            // icons below" never renders inside the frame.
                            class="pointer-events-none min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words p-2 text-darius-text-primary"
                            style={{
                                "font-size": `${fontPx()}px`,
                                "line-height": "1.25",
                                // Ellipsis/fade at rest (D7). An inner scroll
                                // container was rejected: a scrollable element
                                // inside a scale()d world layer fights canvas zoom
                                // for wheel events, and hides content from a view
                                // whose whole purpose is seeing everything at once.
                                "mask-image":
                                    "linear-gradient(to bottom, black calc(100% - 1.5em), transparent 100%)"
                            }}
                        >
                            {props.annotation.text}
                        </div>
                    }
                >
                    <textarea
                        ref={textareaRef}
                        value={textSignal()}
                        disabled={!props.canEdit()}
                        class="h-full w-full resize-none bg-transparent p-2 text-darius-text-primary outline-none"
                        style={{ "font-size": `${fontPx()}px`, "line-height": "1.25" }}
                        onFocus={() => setIsTextFocused(true)}
                        onInput={(e) => setTextSignal(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            // Enter inserts a newline: the text is multi-line by
                            // design (D6, `\n` preserved). Escape commits, matching
                            // the draft-name field rather than the team-name field.
                            if (e.key === "Escape") {
                                e.stopPropagation();
                                e.currentTarget.blur();
                            }
                        }}
                        onBlur={commitText}
                    />
                </Show>
            </Show>

            <Show when={props.annotation.championIds.length > 0 || canEditStrip()}>
                {/* Text ABOVE, icons below (design D3). The strip wraps and
                    clips with the box rather than scrolling — an inner scroll
                    container inside a scale()d world layer fights canvas zoom
                    for wheel events (D7). */}
                <div class="pointer-events-auto flex shrink-0 flex-wrap gap-1 overflow-hidden px-2 pb-2">
                    <For each={resolveStripChampions(props.annotation.championIds)}>
                        {(chip) => (
                            <div class="group/chip relative">
                                <Show
                                    when={chip.resolved}
                                    fallback={
                                        <div
                                            class="flex h-8 w-8 items-center justify-center rounded border border-dashed border-darius-crimson text-[8px] text-darius-crimson"
                                            title={`Unknown champion: ${chip.id}`}
                                        >
                                            {chip.id.slice(0, 4)}
                                        </div>
                                    }
                                >
                                    {(champion) => (
                                        <ChampionPortrait
                                            src={champion().img}
                                            alt={champion().name}
                                            class="h-8 w-8 rounded"
                                        />
                                    )}
                                </Show>
                                <Show when={canEditStrip()}>
                                    <button
                                        class="absolute -right-1 -top-1 hidden h-4 w-4 rounded-full bg-darius-crimson text-[10px] leading-none text-darius-text-primary group-hover/chip:block"
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() =>
                                            props.onRemoveChampion(
                                                props.annotation.id,
                                                chip.id
                                            )
                                        }
                                    >
                                        ×
                                    </button>
                                </Show>
                            </div>
                        )}
                    </For>
                    <Show when={canEditStrip()}>
                        <button
                            class="flex h-8 w-8 items-center justify-center rounded border border-dashed border-darius-purple-bright text-darius-purple-bright"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => props.onAddChampion(props.annotation.id)}
                        >
                            +
                        </button>
                    </Show>
                </div>
            </Show>

            <Show when={props.canEdit() && !props.isConnectionMode && props.isSelected()}>
                <ResizeGrip
                    corner="sw"
                    size={resizeHandleWorldPx(
                        props.zoom(),
                        Math.min(renderWidth(), renderHeight())
                    )}
                    onMouseDown={(e) => handleResizeMouseDown(e, "sw")}
                />
                <ResizeGrip
                    corner="se"
                    // Screen-constant and capped, via the shared rule the
                    // Group's grip uses. The old `screenConstantPx(12, …)` was
                    // constant on screen but only 12px of it, and — uncapped —
                    // resolved to 120 WORLD px at MIN_ZOOM, which is more than
                    // a minimum 56x40 note is, so the handle covered the note
                    // and swallowed its drag.
                    size={resizeHandleWorldPx(
                        props.zoom(),
                        Math.min(renderWidth(), renderHeight())
                    )}
                    onMouseDown={(e) => handleResizeMouseDown(e, "se")}
                />
            </Show>
        </div>
    );
};

export default CanvasAnnotation;
