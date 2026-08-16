import {
    Component,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup,
    untrack,
    type JSX
} from "solid-js";
import type { Viewport } from "../utils/schemas";
import {
    EDGE_GAP,
    chooseAnchorScreenPoint,
    clampToPane,
    screenPointToWorld,
    worldPointToScreen,
    type Point
} from "../utils/popoverAnchor";

type CanvasPickerPopoverProps = {
    /** Identity of the element the popover anchors beside; null = nothing open. */
    anchorKey: () => string | null;
    /** Bumped by the caller to re-anchor fresh beside the target. */
    anchorSession: () => number;
    /**
     * Read the anchored row's reactive position inputs so the anchor
     * re-derives on drag / re-group / reflow. Return false when the row is
     * gone — the CALLER's own lifecycle effect owns closing in that case.
     */
    trackAnchorPosition: (key: string) => boolean;
    /** Resolve the anchored element. Called inside rAF, after layout. */
    resolveAnchorElement: (key: string) => HTMLElement | null;
    viewport: () => Viewport;
    onClose: () => void;
    children: JSX.Element;
};

// Anchored = glued to the card at a fixed world point (rides pan/zoom, even
// off-screen). Floating = detached screen-space window that ignores pan/zoom.
type Placement =
    | { mode: "anchored"; anchorWorld: Point | null }
    | { mode: "floating"; x: number; y: number };

export const CanvasPickerPopover: Component<CanvasPickerPopoverProps> = (props) => {
    const [placement, setPlacement] = createSignal<Placement>({
        mode: "anchored",
        anchorWorld: null
    });
    const [paneRect, setPaneRect] = createSignal<DOMRect | null>(null);
    let popoverEl: HTMLDivElement | undefined;

    // Any slot click re-anchors fresh; advance never moves the popover (D3).
    createEffect(
        on(
            () => props.anchorSession(),
            () => setPlacement({ mode: "anchored", anchorWorld: null })
        )
    );

    // Pane bounds: re-read on size changes (sidebar toggle, window resize).
    createEffect(() => {
        if (props.anchorKey() === null) return;
        const pane = document.querySelector(".canvas-background");
        if (!(pane instanceof HTMLElement)) return;
        setPaneRect(pane.getBoundingClientRect());
        const observer = new ResizeObserver(() =>
            setPaneRect(pane.getBoundingClientRect())
        );
        observer.observe(pane);
        onCleanup(() => observer.disconnect());
    });

    // Anchor derivation: runs per anchor session and whenever the anchored
    // card's own position inputs change (drag, re-group, series reflow).
    // Deliberately does NOT track viewport, placement, or the target's
    // pickIndex — pan/zoom must hit only the pure render-path memo below,
    // and advance must never move the popover (design D3).
    createEffect(() => {
        props.anchorSession();
        const key = props.anchorKey();
        if (key === null) return;
        if (!props.trackAnchorPosition(key)) return;
        if (untrack(placement).mode !== "anchored") return;

        // rAF so the DOM reflects the position change before measuring.
        requestAnimationFrame(() => {
            if (untrack(props.anchorKey) !== key) return;
            if (untrack(placement).mode !== "anchored") return;
            const anchorEl = props.resolveAnchorElement(key);
            const pane = document
                .querySelector(".canvas-background")
                ?.getBoundingClientRect();
            if (!anchorEl || !pane) {
                // Element gone mid-derivation → treat as deleted (design D3).
                props.onClose();
                return;
            }
            setPaneRect(pane);
            const viewport = props.viewport();
            const screenPoint = chooseAnchorScreenPoint(
                anchorEl.getBoundingClientRect(),
                pane
            );
            setPlacement({
                mode: "anchored",
                anchorWorld: screenPointToWorld(
                    screenPoint,
                    { x: pane.left, y: pane.top },
                    viewport
                )
            });
        });
    });

    // Pure render-path positioning: recomputes per viewport change, no
    // measurement, no rAF, no frame lag.
    const positionStyle = createMemo(() => {
        const p = placement();
        if (p.mode === "floating") {
            return { left: `${p.x}px`, top: `${p.y}px` };
        }
        const pane = paneRect();
        if (!p.anchorWorld || !pane) {
            return { left: "-9999px", top: "0px" }; // park until first measurement
        }
        const screen = worldPointToScreen(
            p.anchorWorld,
            { x: pane.left, y: pane.top },
            props.viewport()
        );
        return { left: `${screen.x}px`, top: `${screen.y}px` };
    });

    // Dragging the handle detaches into a free-floating screen-space window,
    // pane-clamped only while dragging (design D3).
    const startDrag = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startRect = popoverEl?.getBoundingClientRect();
        const startLeft = startRect?.left ?? EDGE_GAP;
        const startTop = startRect?.top ?? EDGE_GAP;
        const startX = e.clientX;
        const startY = e.clientY;
        const onMove = (move: MouseEvent) => {
            const pane = paneRect();
            if (!pane) return;
            const clamped = clampToPane(
                startLeft + (move.clientX - startX),
                startTop + (move.clientY - startY),
                pane
            );
            setPlacement({ mode: "floating", x: clamped.x, y: clamped.y });
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    return (
        <Show when={props.anchorKey() !== null}>
            <div
                ref={popoverEl}
                class="canvas-picker-popover fixed z-[60] w-96"
                style={positionStyle()}
                onMouseDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
            >
                <div
                    class="flex cursor-move items-center justify-center gap-1.5 rounded-t-lg border border-b-0 border-darius-border bg-darius-card-hover px-3 py-1"
                    onMouseDown={startDrag}
                    title="Drag to reposition"
                >
                    <span class="text-[10px] font-semibold uppercase tracking-[0.2em] text-darius-text-secondary">
                        ⠿ drag
                    </span>
                </div>
                {props.children}
            </div>
        </Show>
    );
};
