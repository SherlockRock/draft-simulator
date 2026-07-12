import {
    Component,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup,
    untrack
} from "solid-js";
import { CanvasDraft, Viewport } from "../utils/schemas";
import {
    CardLayout,
    getDirectionalCanvasSlotIndex,
    getEnterAdvanceSlotIndex,
    getIndexToShorthandForLayout
} from "../utils/canvasCardLayout";
import {
    EDGE_GAP,
    chooseAnchorScreenPoint,
    clampToPane,
    screenPointToWorld,
    worldPointToScreen,
    type Point
} from "../utils/popoverAnchor";
import { ChampionPickerCore } from "./ChampionPickerCore";

export interface PickerTarget {
    draftId: string;
    pickIndex: number;
}

// Anchored = glued to the card at a fixed world point (rides pan/zoom, even
// off-screen). Floating = detached screen-space window that ignores pan/zoom.
type Placement =
    | { mode: "anchored"; anchorWorld: Point | null }
    | { mode: "floating"; x: number; y: number };

type CanvasChampionPickerProps = {
    target: () => PickerTarget | null;
    /** Bumped by Canvas on every slot click — re-anchors fresh beside that card. */
    anchorSession: () => number;
    onRetarget: (target: PickerTarget) => void;
    onClose: () => void;
    handlePickChange: (draftId: string, pickIndex: number, championId: string) => void;
    getDraft: (draftId: string) => CanvasDraft | undefined;
    getUnavailableChampionIds: (draftId: string) => Set<string>;
    cardLayout: () => CardLayout;
    viewport: () => Viewport;
};

export const CanvasChampionPicker: Component<CanvasChampionPickerProps> = (props) => {
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

    // Notifies only when the anchored CARD changes — advance retargets within
    // the same card and must NOT re-derive the anchor (a re-measure re-clamps,
    // which would move a popover the user had panned partly off-pane).
    const targetDraftId = createMemo(() => props.target()?.draftId ?? null);
    const isOpen = createMemo(() => props.target() !== null);

    // Pane bounds: re-read on size changes (sidebar toggle, window resize).
    createEffect(() => {
        if (!isOpen()) return;
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
        const draftId = targetDraftId();
        if (draftId === null) return;
        const canvasDraft = props.getDraft(draftId);
        if (!canvasDraft) return; // Canvas-level lifecycle effect closes the picker
        void canvasDraft.positionX;
        void canvasDraft.positionY;
        void canvasDraft.group_id;
        void canvasDraft.Draft.seriesIndex;
        if (untrack(placement).mode !== "anchored") return;

        // rAF so the DOM reflects the position change before measuring.
        requestAnimationFrame(() => {
            const current = props.target();
            if (!current || current.draftId !== draftId) return;
            if (untrack(placement).mode !== "anchored") return;
            const cardEl = document.querySelector(
                `.canvas-card[data-draft-id="${draftId}"]`
            );
            const pane = document
                .querySelector(".canvas-background")
                ?.getBoundingClientRect();
            if (!(cardEl instanceof HTMLElement) || !pane) {
                // Element gone mid-derivation → treat as deleted (design D3).
                props.onClose();
                return;
            }
            setPaneRect(pane);
            const viewport = props.viewport();
            const screenPoint = chooseAnchorScreenPoint(
                cardEl.getBoundingClientRect(),
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

    const advance = (reverse: boolean) => {
        const target = props.target();
        if (!target) return;
        const next = getEnterAdvanceSlotIndex(
            props.cardLayout(),
            target.pickIndex,
            reverse ? "backward" : "forward"
        );
        if (next === null) {
            props.onClose();
        } else {
            props.onRetarget({ draftId: target.draftId, pickIndex: next });
        }
    };

    const handlePick = (championId: string, reverse: boolean) => {
        const target = props.target();
        if (!target) return;
        props.handlePickChange(target.draftId, target.pickIndex, championId);
        advance(reverse);
    };

    const handleTab = (reverse: boolean) => {
        const target = props.target();
        if (!target) return;
        props.onRetarget({
            draftId: target.draftId,
            pickIndex: getDirectionalCanvasSlotIndex(
                props.cardLayout(),
                target.pickIndex,
                "horizontal",
                reverse ? "backward" : "forward"
            )
        });
    };

    const unavailableIds = createMemo(() => {
        const target = props.target();
        return target
            ? props.getUnavailableChampionIds(target.draftId)
            : new Set<string>();
    });

    const contextLabel = createMemo(() => {
        const target = props.target();
        if (!target) return "";
        const name = props.getDraft(target.draftId)?.Draft.name.trim();
        const slot =
            getIndexToShorthandForLayout(props.cardLayout())[target.pickIndex] ??
            `#${target.pickIndex + 1}`;
        return name ? `${name} — ${slot}` : slot;
    });

    return (
        <Show when={props.target()}>
            {(target) => (
                <div
                    ref={popoverEl}
                    class="fixed z-[60] w-96"
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
                    <ChampionPickerCore
                        onPick={handlePick}
                        onSkip={advance}
                        onTab={handleTab}
                        onClose={props.onClose}
                        isAvailable={(id) => !unavailableIds().has(id)}
                        contextLabel={contextLabel()}
                        targetKey={`${target().draftId}:${target().pickIndex}`}
                    />
                </div>
            )}
        </Show>
    );
};
