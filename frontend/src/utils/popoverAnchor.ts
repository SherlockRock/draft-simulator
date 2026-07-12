// Positioning math for the canvas champion-picker popover (design D3).
// All functions are pure; the shell measures DOM rects and feeds them in.

export interface Point {
    x: number;
    y: number;
}

export interface ViewportState {
    x: number;
    y: number;
    zoom: number;
}

export interface ScreenRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export const PICKER_WIDTH = 384; // matches the shell's w-96
export const PICKER_EST_HEIGHT = 560;
export const EDGE_GAP = 8;

// getBoundingClientRect is window-relative but the canvas transform is
// pane-relative, so the pane origin must be subtracted before inverting —
// omitting it produces a sidebar/header-sized offset (design D3).
export const screenPointToWorld = (
    screen: Point,
    paneOrigin: Point,
    viewport: ViewportState
): Point => ({
    x: (screen.x - paneOrigin.x) / viewport.zoom + viewport.x,
    y: (screen.y - paneOrigin.y) / viewport.zoom + viewport.y
});

export const worldPointToScreen = (
    world: Point,
    paneOrigin: Point,
    viewport: ViewportState
): Point => ({
    x: paneOrigin.x + (world.x - viewport.x) * viewport.zoom,
    y: paneOrigin.y + (world.y - viewport.y) * viewport.zoom
});

// Applied only to the initial open placement and while dragging — never while
// anchored (rigid follow may carry the popover off-screen; that's by design).
export const clampToPane = (x: number, y: number, pane: ScreenRect): Point => {
    const minX = pane.left + EDGE_GAP;
    const maxX = pane.right - PICKER_WIDTH - EDGE_GAP;
    const minY = pane.top + EDGE_GAP;
    const maxY = pane.bottom - PICKER_EST_HEIGHT - EDGE_GAP;
    return {
        x: Math.min(Math.max(x, minX), Math.max(maxX, minX)),
        y: Math.min(Math.max(y, minY), Math.max(maxY, minY))
    };
};

export const chooseAnchorScreenPoint = (
    cardRect: ScreenRect,
    pane: ScreenRect
): Point => {
    const maxLeft = pane.right - PICKER_WIDTH - EDGE_GAP;
    const fitsRight = cardRect.right + EDGE_GAP <= maxLeft;
    const rawX = fitsRight
        ? cardRect.right + EDGE_GAP
        : cardRect.left - EDGE_GAP - PICKER_WIDTH;
    return clampToPane(rawX, cardRect.top, pane);
};
