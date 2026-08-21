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
    // Non-null only for the row currently previewed as an armed champion
    // drag's landing target (resolved via `resolvePoolDrop`, so it can never
    // highlight a row the drop won't actually land on).
    dropHighlightRole: () => Role | null;
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
                    return (
                        <div
                            data-role={role}
                            class="flex min-h-[48px] items-start gap-2 border-b border-darius-border/40 px-3 py-1.5 last:rounded-b-lg last:border-b-0"
                            classList={{
                                "bg-darius-purple-bright/10 ring-1 ring-inset ring-darius-purple-bright":
                                    props.dropHighlightRole() === role
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
                                <For each={bucket()}>
                                    {(championId) => {
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
                                        return (
                                            <div
                                                class="group relative overflow-hidden rounded"
                                                data-champion-id={championId}
                                                classList={{
                                                    "cursor-grab": props.canEdit(),
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
