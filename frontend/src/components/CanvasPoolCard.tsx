import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { Pencil } from "lucide-solid";
import type { CanvasPoolPlacement, Role } from "../utils/schemas";
import { ROLES, ROLE_LABELS } from "../utils/championRoles";
import { RoleIcon } from "./scouting/PlayerPanel";
import { champions as championCatalog } from "../utils/constants";
import {
    POOL_CARD_WIDTH,
    POOL_PORTRAIT_PX,
    commitPoolNameEdit,
    flexRolesByChampion,
    poolChampionTotal
} from "../utils/poolCard";

type CanvasPoolCardProps = {
    // No `zoom` prop on purpose: the card is pure world-space (§7) with no
    // screen-constant chrome or LOD in v1 — an unread prop is an
    // unimplemented branch, not future-proofing.
    placement: CanvasPoolPlacement;
    canEdit: () => boolean;
    isSelected: () => boolean;
    isRenaming: () => boolean;
    onStartRename: (placementId: string) => void;
    onCommitRename: (placementId: string, name: string) => void;
    onCancelRename: () => void;
    onMouseDown: (e: MouseEvent, placement: CanvasPoolPlacement) => void;
    // No onContextMenu prop: canvas object menus resolve CENTRALLY at
    // right-mouse-up via dispatchContextMenu's el.closest() table (~5097) —
    // annotations have no such prop either. Task 9 adds the
    // ".canvas-pool-card" branch there; a per-component handler would open
    // the pool menu AND the background fallback menu together.
    // Slice 3: onOpenRolePicker opens the + picker (Task 14). Removal is NOT a
    // prop: it lives on the champion context menu, resolved centrally by
    // dispatchContextMenu off the tile's data-champion-id (same reason the
    // card's own menu has no onContextMenu prop). The hover-× this replaced
    // put a red button on every portrait and left right-click falling through
    // to the pool menu, where a mis-aimed click offered to delete the pool.
    onOpenRolePicker: (placementId: string, role: Role) => void;
    // Opens the bulk overlay editor (Task 16) for this placement. Header icon
    // + the card's context menu ("Edit in overlay") both drive this — mirrors
    // onStartRename's split between a header affordance and a menu entry.
    onOpenOverlay: (placementId: string) => void;
    // Task 18: arms a pending champion drag (Canvas.tsx's
    // `onPortraitMouseDown`) — DISTINCT from `onMouseDown` above, which is
    // the card drag. The portrait tile stops propagation before calling this
    // so the card root's onMouseDown never sees the event.
    onPortraitMouseDown: (
        e: MouseEvent,
        placementId: string,
        role: Role,
        championId: string
    ) => void;
    // Non-null only for the row+slot currently previewed as an armed champion
    // drag's landing target. `index` is the SAME insertion index
    // `resolvePoolDrop` consumes, so the caret cannot point at a slot the drop
    // won't use — that identity is the whole reason the resolver takes an
    // index instead of re-deriving one at commit time.
    dropPreview: () => { role: Role; index: number } | null;
    // The tile currently being carried, when it belongs to THIS card — so the
    // source can paint a lifted state while the drag is armed. Matched on
    // (role, championId), not championId alone: a flexed champion has a tile
    // in several rows and only the one actually grabbed is in transit.
    dragSource: () => { role: Role; championId: string } | null;
};

type PoolNameInputProps = {
    placementId: string;
    initialName: string;
    onCommitRename: (placementId: string, name: string) => void;
    onCancelRename: () => void;
};

// Mounted fresh by the <Show> below only while renaming, so `value` seeds
// once from `initialName` and is never resynced afterward — a resync effect
// keyed off the pool's live name would blow away what the user is typing the
// instant a collaborator's edit (or this rename's own optimistic write)
// reconciles in. onBlur (and Enter, which just blurs) delegate to
// `commitPoolNameEdit`, which reads `value()` before calling
// `onCancelRename` — see that function's doc for why.
const PoolNameInput: Component<PoolNameInputProps> = (props) => {
    const [value, setValue] = createSignal(props.initialName);
    // Set by Escape BEFORE onCancelRename() runs. Escape's onCancelRename()
    // unmounts this input via the card's <Show>, and removing a focused
    // element fires a native `blur` synchronously — so onBlur's
    // commitPoolNameEdit call runs a second time right after Escape. This
    // flag is what tells that second run to no-op instead of committing the
    // just-cancelled edit (runtime-confirmed regression, not hypothetical).
    let cancelled = false;

    return (
        <input
            type="text"
            value={value()}
            class="w-full select-text truncate rounded border border-darius-border bg-darius-card px-1 text-sm font-semibold text-darius-text-primary outline-none focus:border-darius-purple-bright"
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.currentTarget.blur();
                    return;
                }
                if (e.key === "Escape") {
                    // Cancels without committing — stopPropagation keeps this
                    // Escape from also bubbling to canvas-level handling.
                    e.stopPropagation();
                    cancelled = true;
                    props.onCancelRename();
                }
            }}
            onBlur={() =>
                commitPoolNameEdit(
                    value,
                    props.placementId,
                    props.onCancelRename,
                    props.onCommitRename,
                    () => cancelled
                )
            }
            autofocus
        />
    );
};

/** The in-flow caret bar's own width. */
const CARET_WIDTH_PX = 3;
/** The row wrapper's `gap-1`, i.e. 0.25rem. */
const ROW_GAP_PX = 4;

/**
 * The insertion marker painted between two portraits during a champion drag.
 * Full tile height so it reads as a slot rather than a stray line, and sized
 * in world px like everything else on the card (§7: the card is pure
 * world-space, so this scales with zoom instead of staying screen-constant).
 *
 * Two parts, and the split is load-bearing:
 *
 *  - The 3px bar is the only thing IN FLOW. Its box is byte-identical to the
 *    caret this replaced, which is what lets the runtime-proven hit-test
 *    stability carry over unchanged: `insertionIndexFromRects` measures
 *    `[data-champion-id]` rects, and the caret still only ever pushes tiles at
 *    index >= i further from the cursor. Anything that widened this box, or
 *    opened a real gap, would reflow those very rects and invalidate the proof.
 *
 *  - The landing rectangle is ABSOLUTELY positioned and therefore consumes no
 *    layout at all. It shows the SLOT the portrait will occupy rather than
 *    just the seam it goes through — the grid drop affordance's whole point
 *    (`GridDropHighlight`), and it borrows that component's exact visual
 *    vocabulary: a 2px purple border over a 10% purple fill.
 *
 * `pointer-events-none` matters as much as it does on the ghost: the rect
 * paints over its neighbours, and `hitTestPoolDropTarget` resolves through
 * `document.elementFromPoint`, so a hit-testable overlay here would shadow the
 * tiles the hit-test is trying to read.
 */


const DropCaret: Component = () => (
    <div
        class="relative z-10 shrink-0 rounded-full bg-darius-purple-bright"
        style={{ width: `${CARET_WIDTH_PX}px`, height: `${POOL_PORTRAIT_PX}px` }}
    >
        <div
            class="pointer-events-none absolute rounded border-2 border-darius-purple-bright bg-darius-purple-bright/10"
            style={{
                // Sits ONE FULL SLOT over — flush against the tile that
                // follows the caret — rather than centred on the bar.
                //
                // Centred, the rect reached 14.5px into the tile on either
                // side (18.5px of overhang less the 4px gap), so it half-
                // covered two champions and read as misalignment rather than
                // as a claim on a slot.
                //
                // Offset by one gap past the bar it lands exactly on the
                // following tile's footprint, which is precisely where the
                // dragged portrait ends up: inserting at index i puts it where
                // tile i currently sits and pushes tile i to the right. That
                // holds at both ends of the row — at index 0 it covers the
                // first tile, and at the tail it covers the "+" button, which
                // is where an appended champion goes.
                left: `${CARET_WIDTH_PX + ROW_GAP_PX}px`,
                top: "0px",
                width: `${POOL_PORTRAIT_PX}px`,
                height: `${POOL_PORTRAIT_PX}px`
            }}
        />
    </div>
);

export const CanvasPoolCard: Component<CanvasPoolCardProps> = (props) => {
    const championById = createMemo(() => {
        const byId = new Map<string, { name: string; img: string }>();
        for (const c of championCatalog) byId.set(c.id, { name: c.name, img: c.img });
        return byId;
    });
    const flexRoles = createMemo(() =>
        flexRolesByChampion(props.placement.Pool.champions)
    );
    const total = createMemo(() => poolChampionTotal(props.placement.Pool.champions));

    return (
        <div
            class="canvas-pool-card absolute rounded-lg border bg-darius-card shadow-lg"
            data-pool-id={props.placement.id}
            classList={{
                "border-darius-border": !props.isSelected(),
                "border-darius-purple-bright ring-2 ring-darius-purple-bright/40":
                    props.isSelected()
            }}
            style={{
                left: `${props.placement.positionX}px`,
                top: `${props.placement.positionY}px`,
                width: `${POOL_CARD_WIDTH}px`
            }}
            onMouseDown={(e) => props.onMouseDown(e, props.placement)}
        >
            {/* Header: name + unique count */}
            <div class="flex items-center justify-between border-b border-darius-border/60 px-3 py-2">
                <Show
                    when={props.isRenaming()}
                    fallback={
                        <span
                            class="truncate text-sm font-semibold text-darius-text-primary"
                            onDblClick={() => {
                                if (props.canEdit())
                                    props.onStartRename(props.placement.id);
                            }}
                        >
                            {props.placement.Pool.name}
                        </span>
                    }
                >
                    <PoolNameInput
                        placementId={props.placement.id}
                        initialName={props.placement.Pool.name}
                        onCommitRename={props.onCommitRename}
                        onCancelRename={props.onCancelRename}
                    />
                </Show>
                <Show when={props.canEdit()}>
                    <button
                        type="button"
                        title="Edit in overlay"
                        class="ml-2 shrink-0 rounded p-1 text-darius-text-secondary transition-colors hover:text-darius-purple-bright"
                        // Must not start a card drag: mirrors the role-picker
                        // "+" tile's onMouseDown stopPropagation above.
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => props.onOpenOverlay(props.placement.id)}
                    >
                        <Pencil size={14} />
                    </button>
                </Show>
                <span class="ml-2 shrink-0 rounded-full border border-darius-border px-2 py-0.5 text-[10px] text-darius-text-secondary">
                    {total()} champions
                </span>
            </div>

            {/* Five role rows, always rendered — the rails ARE the affordance map */}
            <For each={ROLES}>
                {(role) => {
                    const bucket = () => props.placement.Pool.champions[role];
                    // The caret slot for THIS row, or null when the drag is
                    // aimed elsewhere.
                    const caretIndex = (): number | null => {
                        const preview = props.dropPreview();
                        return preview && preview.role === role ? preview.index : null;
                    };
                    return (
                        <div
                            data-role={role}
                            class="flex min-h-[48px] items-start gap-2 border-b border-darius-border/40 px-3 py-1.5 last:rounded-b-lg last:border-b-0"
                            classList={{
                                "bg-darius-purple-bright/10 ring-1 ring-inset ring-darius-purple-bright":
                                    caretIndex() !== null
                            }}
                        >
                            {/* RoleIcon is already exported from
                                scouting/PlayerPanel.tsx (~36) and does the
                                CSS-mask + ROLE_COLOR tint correctly — reuse it.
                                (ROLE_COLOR[role].icon is a Tailwind CLASS
                                string like "bg-red-400", NOT a color value —
                                hand-rolling it into style={} paints nothing.)
                                data-role on the row feeds slice 5 hit-testing. */}
                            <div
                                class="mt-1 shrink-0"
                                classList={{ "opacity-40": bucket().length === 0 }}
                            >
                                {/* RoleIcon carries its own title; size via class
                                    (verified signature: { role, active, class? }) */}
                                <RoleIcon
                                    role={role}
                                    active={bucket().length > 0}
                                    class="h-7 w-7"
                                />
                            </div>
                            <div class="flex flex-wrap gap-1">
                                <Show when={caretIndex() === 0}>
                                    <DropCaret />
                                </Show>
                                <For each={bucket()}>
                                    {(championId, tileIndex) => {
                                        const champ = () =>
                                            championById().get(championId);
                                        const flexed = () => flexRoles().get(championId);
                                        const flexTitle = () => {
                                            const name = champ()?.name ?? championId;
                                            const roles = flexed();
                                            if (!roles) return name;
                                            const others = roles
                                                .filter((r) => r !== role)
                                                .map((r) => ROLE_LABELS[r])
                                                .join(", ");
                                            return `${name} — also in ${others}`;
                                        };
                                        // In transit: the grid drag's card
                                        // physically leaves its cell, so the
                                        // origin reads as vacated. A pool tile
                                        // cannot leave without reflowing the
                                        // row (and the rects the hit-test
                                        // measures), so it stays in place and
                                        // says the same thing in paint only.
                                        const isDragSource = () => {
                                            const src = props.dragSource();
                                            return (
                                                !!src &&
                                                src.role === role &&
                                                src.championId === championId
                                            );
                                        };
                                        return (
                                          <>
                                            <div
                                                class="group relative overflow-hidden rounded transition-opacity"
                                                data-champion-id={championId}
                                                classList={{
                                                    "cursor-grab": props.canEdit(),
                                                    "opacity-35 grayscale":
                                                        isDragSource(),
                                                    // A flexed champion reads as a CLASS at any
                                                    // zoom: the whole tile is outlined, not a 12px
                                                    // corner wedge that dropped out below ~0.5
                                                    // zoom and never said which tiles were the
                                                    // same champion. The tooltip still names the
                                                    // other roles.
                                                    "border-2 border-amber-400": !!flexed(),
                                                    "border border-darius-border": !flexed()
                                                }}
                                                style={{
                                                    width: `${POOL_PORTRAIT_PX}px`,
                                                    height: `${POOL_PORTRAIT_PX}px`
                                                }}
                                                title={flexTitle()}
                                                // Arms a pending champion drag (Task 18) —
                                                // stopPropagation keeps the card root's own
                                                // onMouseDown (card drag) from also firing.
                                                // Gated on canEdit so a view-only user's
                                                // mousedown still bubbles to the card root
                                                // exactly as before this task (where it
                                                // no-ops on that handler's own canEdit check).
                                                onMouseDown={(e) => {
                                                    if (!props.canEdit()) return;
                                                    e.stopPropagation();
                                                    props.onPortraitMouseDown(
                                                        e,
                                                        props.placement.id,
                                                        role,
                                                        championId
                                                    );
                                                }}
                                            >
                                                <Show
                                                    when={champ()}
                                                    fallback={
                                                        <div class="flex h-full w-full items-center justify-center bg-darius-card text-[9px] text-darius-text-secondary">
                                                            {championId}
                                                        </div>
                                                    }
                                                >
                                                    {(c) => (
                                                        <img
                                                            src={c().img}
                                                            alt={c().name}
                                                            draggable={false}
                                                            class="h-full w-full object-cover"
                                                        />
                                                    )}
                                                </Show>
                                            </div>
                                            {/* The caret for the slot AFTER
                                                this tile. A fragment keeps it a
                                                sibling, so it never lands
                                                inside a [data-champion-id]
                                                element the hit-test measures. */}
                                            <Show
                                                when={caretIndex() === tileIndex() + 1}
                                            >
                                                <DropCaret />
                                            </Show>
                                          </>
                                        );
                                    }}
                                </For>
                                <Show when={props.canEdit()}>
                                    <button
                                        type="button"
                                        class="flex shrink-0 items-center justify-center rounded border border-dashed border-darius-border text-darius-text-secondary transition-colors hover:border-darius-purple-bright hover:text-darius-purple-bright"
                                        style={{
                                            width: `${POOL_PORTRAIT_PX}px`,
                                            height: `${POOL_PORTRAIT_PX}px`
                                        }}
                                        title={`Add to ${ROLE_LABELS[role]}`}
                                        // Must not start a card drag: the row's
                                        // ancestor mousedown handler (props.onMouseDown
                                        // on the card root) would otherwise fire first.
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() =>
                                            props.onOpenRolePicker(
                                                props.placement.id,
                                                role
                                            )
                                        }
                                    >
                                        +
                                    </button>
                                </Show>
                            </div>
                        </div>
                    );
                }}
            </For>

            <Show when={props.canEdit() && total() === 0}>
                <div class="px-3 pb-2 pt-1 text-[10px] text-darius-text-secondary">
                    {/* Overlay editor lands in Task 16 — final copy names it
                        too once it exists. */}
                    Use the + tiles to add champions
                </div>
            </Show>
        </div>
    );
};
