import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { CanvasAnnotation as CanvasAnnotationRow } from "../utils/schemas";
import { annotationSurfaceClass, ANNOTATION_FONT_PX } from "../utils/annotationStyle";
import { MIN_ANNOTATION_HEIGHT, MIN_ANNOTATION_WIDTH } from "../utils/annotationSize";
import { scaledStrokePx, screenConstantPx } from "../utils/viewport";

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
    onCommitText: (annotationId: string, text: string, measuredHeight: number) => void;
    onResize: (annotationId: string, width: number, height: number) => void;
    onResizeEnd: (annotationId: string, width: number, height: number) => void;
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
    const renderWidth = () => props.snappedSize()?.width ?? props.annotation.width;
    const renderHeight = () => props.snappedSize()?.height ?? props.annotation.height;

    const fontPx = createMemo(() => ANNOTATION_FONT_PX[props.annotation.fontSize]);

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
                top: `${props.annotation.positionY}px`,
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

            {/* Champion strip lands in slice 3. */}

            <Show when={props.canEdit() && !props.isConnectionMode && props.isSelected()}>
                <div
                    class="absolute bottom-0 right-0 cursor-nwse-resize"
                    style={{
                        width: `${screenConstantPx(12, props.zoom())}px`,
                        height: `${screenConstantPx(12, props.zoom())}px`
                    }}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        const startX = e.clientX;
                        const startY = e.clientY;
                        const startWidth = props.annotation.width;
                        const startHeight = props.annotation.height;

                        const onMove = (move: MouseEvent) => {
                            // Clamped to the RESIZE MINIMUM, not to the manual
                            // floor — this gesture is what SETS the floor, so
                            // reading it here would ratchet the note's size up
                            // and make it un-shrinkable by hand.
                            const width = Math.max(
                                MIN_ANNOTATION_WIDTH,
                                startWidth + (move.clientX - startX) / props.zoom()
                            );
                            const height = Math.max(
                                MIN_ANNOTATION_HEIGHT,
                                startHeight + (move.clientY - startY) / props.zoom()
                            );
                            props.onResize(props.annotation.id, width, height);
                        };
                        const onUp = () => {
                            window.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mouseup", onUp);
                            props.onResizeEnd(
                                props.annotation.id,
                                props.annotation.width,
                                props.annotation.height
                            );
                        };
                        window.addEventListener("mousemove", onMove);
                        window.addEventListener("mouseup", onUp);
                    }}
                />
            </Show>
        </div>
    );
};

export default CanvasAnnotation;
