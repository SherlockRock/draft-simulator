import {
    Component,
    For,
    Index,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup
} from "solid-js";
import { Portal } from "solid-js/web";
import type { RolePoolMap } from "@draft-sim/shared-types";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { ROLES, ROLE_LABELS, getChampionImg } from "../../utils/championRoles";
import { resolveChampion } from "../../utils/constants";
import { banSignalAbsent } from "../../utils/navigatorColumns";
import {
    highlightedId,
    initialHighlight,
    matchQuery,
    moveHighlight,
    poolColumns,
    poolSideFor,
    singleMatchLabel,
    visibleTiles,
    type Highlight,
    type PoolColumnStatus,
    type PoolTurn,
    type PoolView
} from "../../utils/navigatorPoolPanel";
import { ROLE_HEX, otherSide, type Side } from "../../utils/navigatorSeats";
import { turnLabel, turnLabelForSlots } from "../../utils/turnSequence";
import { RoleGlyph, SeatRow } from "./SeatRow";

export interface NavigatorPoolPanelProps {
    /** null = no open turn (complete / archive / between games): the panel renders disabled. */
    turn: PoolTurn | null;
    ourSide: Side;
    view: PoolView;
    onViewChange: (view: PoolView) => void;
    pools: { blue: RolePoolMap; red: RolePoolMap };
    /** Confirmed picks per side. */
    picks: { blue: string[]; red: string[] };
    fan: NavigatorTreeNode[];
    unavailable: Set<string>;
    unavailableReason: (championId: string) => string | null;
    query: string;
    onQueryChange: (query: string) => void;
    /** Incremented by the parent (type-anywhere, the glowing pick row, the `pick` command). */
    focusRequest: number;
    onCommit: (championIds: string[]) => void;
    onExplore: (championId: string) => void;
    /** Esc / Backspace on an empty box: the parent blurs the active element so `/` works again. */
    onBlurToPage: () => void;
    /** A commit for this slot is in flight (plan-level decision 20): tiles disabled, Enter a no-op. */
    committing: boolean;
    canEditPools: boolean;
    onEditPools: () => void;
}

const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;
const sideName = (side: Side): string => (side === "blue" ? "Blue" : "Red");
const VIEWS: { id: PoolView; label: string }[] = [
    { id: "yours", label: "Yours" },
    { id: "enemy", label: "Enemy" },
    { id: "all", label: "All" }
];
const PREVIEW_WIDTH = 240;
/** "open" / "Ashe 72%" — read the union ONCE (TypeScript does not narrow across two accessor calls). */
const statusText = (s: PoolColumnStatus): string =>
    s.kind === "open" ? "open" : `${nameOf(s.occupant)} ${s.pct}%`;

/** Design § 5 + § 6: the side's pool as five role columns under the candidate columns; the
 *  search box owns the keys once focused (its own onKeyDown — no window listener here). */
export const NavigatorPoolPanel: Component<NavigatorPoolPanelProps> = (props) => {
    let inputEl: HTMLInputElement | undefined;
    const [collected, setCollected] = createSignal<string[]>([]);
    const [moved, setMoved] = createSignal<{ col: number; championId: string } | null>(
        null
    );
    const [hint, setHint] = createSignal<string | null>(null);
    const [hovered, setHovered] = createSignal<{ id: string; el: HTMLElement } | null>(
        null
    );
    const [previewEl, setPreviewEl] = createSignal<HTMLElement | null>(null);
    const [previewPos, setPreviewPos] = createSignal<{
        left: number;
        top: number;
    } | null>(null);

    const poolSide = () => poolSideFor(props.view, props.ourSide);
    const clockSide = () => props.turn?.side ?? props.ourSide;
    const seatingSide = () => poolSide() ?? clockSide();
    const partnerOf = () => collected()[0] ?? props.turn?.partnerOf ?? null;
    const columns = createMemo(() => {
        const side = poolSide();
        return poolColumns({
            display: side ? props.pools[side] : null,
            picks: props.picks[seatingSide()],
            fan: props.fan,
            partnerOf: partnerOf(),
            unavailable: props.unavailable,
            nameOf
        });
    });
    const matches = createMemo(() =>
        matchQuery(
            props.query,
            columns().flatMap((c) => c.tiles)
        )
    );
    // The arrowed position is stored as a CHAMPION and re-resolved to an index on every read, so an
    // engine re-rank (tiles reorder) cannot move the highlight onto a different champion; a champion
    // that is no longer visible in its column falls back to the initial highlight.
    const highlight = (): Highlight | null => {
        const m = moved();
        const column = m ? columns()[m.col] : undefined;
        if (m && column) {
            const idx = visibleTiles(column, matches()).findIndex(
                (t) => t.championId === m.championId
            );
            if (idx >= 0) return { col: m.col, idx };
        }
        return initialHighlight(columns(), matches());
    };
    const highlighted = () => highlightedId(columns(), matches(), highlight());
    const noSignal = createMemo(() => banSignalAbsent(props.fan));
    const poolEmpty = () => columns().every((c) => c.tiles.length === 0);
    const verb = (): "picks" | "bans" => (props.turn?.type === "ban" ? "bans" : "picks");
    // The label promises Enter commits: count only matches with an ENABLED tile (used / excluded ones are dimmed, never committable).
    const enabledMatches = createMemo(() => {
        const enabled = new Set(
            columns().flatMap((c) =>
                c.tiles.filter((t) => !t.disabled).map((t) => t.championId)
            )
        );
        return new Map<string, 0 | 1>([...matches()].filter(([id]) => enabled.has(id)));
    });
    const single = () => singleMatchLabel(enabledMatches(), verb(), nameOf);
    const title = () => {
        const turn = props.turn;
        const who = poolSide()
            ? `${sideName(poolSide() ?? props.ourSide)}'s pool`
            : "All champions";
        if (!turn) return `${who} · draft closed`;
        const label =
            turn.collect === 2
                ? turnLabelForSlots([turn.slot, turn.slot + 1])
                : turnLabel(turn.slot);
        const action = turn.type === "ban" ? "Ban" : "Pick";
        const step =
            turn.collect === 2
                ? ` — ${collected().length + 1} of 2`
                : turn.partnerOf !== null
                  ? " — 2 of 2"
                  : "";
        return `${who} · ${action} for ${label}${step}`;
    };

    // `on` fires when its SOURCE invalidates, not when the returned value changes, and the parent
    // hands over a fresh `turn` object on every engine snapshot — so the resets key on a memo of the
    // primitive slot (default equality), never on `props.turn?.slot` directly (Codex r3 finding 2).
    const turnSlot = createMemo(() => props.turn?.slot ?? null);
    // Reset per turn (a commit changes the slot): the pair chip and the hint.
    createEffect(
        on(
            turnSlot,
            () => {
                setCollected([]);
                setHint(null);
            },
            { defer: true }
        )
    );
    // The arrow position survives engine snapshots; it resets on a new query or a new turn.
    // highlightedId returns null if a saved position falls out of range.
    createEffect(
        on([() => props.query, () => props.view, turnSlot], () => setMoved(null), {
            defer: true
        })
    );
    createEffect(
        on(
            () => props.focusRequest,
            () => inputEl?.focus(),
            { defer: true }
        )
    );
    // A tile that became disabled or whose node was replaced must not keep the preview alive
    // (memory solidjs_reconcile_stale_hover: mouseleave never fires on a detached node).
    createEffect(() => {
        const h = hovered();
        columns(); // re-check whenever the tiles are rebuilt (a view reset under a resting cursor)
        if (h && (!h.el.isConnected || props.unavailable.has(h.id))) setHovered(null);
    });
    createEffect(() => {
        const text = hint();
        if (text === null) return;
        const timer = setTimeout(() => setHint(null), 1500);
        onCleanup(() => clearTimeout(timer));
    });
    // Measure the portaled preview AFTER insertion (memory reference_solidjs_patterns).
    createEffect(() => {
        const h = hovered();
        const el = previewEl();
        if (!h || !el) {
            setPreviewPos(null);
            return;
        }
        const r = h.el.getBoundingClientRect();
        const width = el.offsetWidth || PREVIEW_WIDTH;
        const height = el.offsetHeight || 60;
        const left = Math.max(
            8,
            Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8)
        );
        const top = r.top - height - 8 >= 8 ? r.top - height - 8 : r.bottom + 8;
        setPreviewPos({
            left,
            top: Math.max(8, Math.min(top, window.innerHeight - height - 8))
        });
    });

    const choose = (championId: string) => {
        const turn = props.turn;
        if (
            !turn ||
            props.committing ||
            props.unavailable.has(championId) ||
            championId === partnerOf()
        )
            return;
        if (turn.collect === 2 && collected().length === 0) {
            setCollected([championId]);
            props.onQueryChange("");
            return;
        }
        setHovered(null);
        props.onCommit([...collected(), championId]);
    };
    const onKey = (e: KeyboardEvent) => {
        if (!props.turn) return;
        if (e.key === "Enter") {
            e.preventDefault();
            const id = highlighted();
            if (!id) return;
            if (e.shiftKey) {
                if (props.fan.some((n) => n.championIds.includes(id))) {
                    props.onQueryChange(""); // the explore path blurs; a stale query must not greet the next type-anywhere
                    props.onExplore(id);
                } else setHint("not in the fan");
            } else choose(id);
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            props.onQueryChange("");
            props.onBlurToPage();
            return;
        }
        if (e.key === "Backspace" && props.query === "") {
            e.preventDefault();
            props.onBlurToPage();
            return;
        }
        const dir =
            e.key === "ArrowLeft"
                ? "left"
                : e.key === "ArrowRight"
                  ? "right"
                  : e.key === "ArrowUp"
                    ? "up"
                    : e.key === "ArrowDown"
                      ? "down"
                      : null;
        if (dir === null) return;
        e.preventDefault();
        const next = moveHighlight(columns(), matches(), highlight(), dir);
        const championId = highlightedId(columns(), matches(), next);
        setMoved(next && championId ? { col: next.col, championId } : null);
    };
    const previewInput = createMemo(() => {
        const h = hovered();
        const turn = props.turn;
        if (!h || !turn) return null;
        const side: Side = turn.type === "ban" ? otherSide(turn.side) : turn.side;
        const before = [...props.picks[side], ...collected()];
        return {
            ids: [...before, h.id],
            candidateIds: [...collected(), h.id],
            beforeIds: props.picks[side],
            side,
            slash: turn.type === "ban",
            id: h.id
        };
    });

    return (
        <div
            data-pool-panel
            data-pool-view={props.view}
            data-pool-disabled={props.turn === null ? "true" : "false"}
            class="flex min-h-0 flex-1 flex-col gap-2 border-t border-darius-border/60 px-3 pb-3 pt-2"
        >
            <div class="flex flex-wrap items-center gap-3">
                <span
                    data-pool-title
                    class="text-[11px] uppercase tracking-wider text-sky-300"
                >
                    {title()}
                </span>
                <span class="relative">
                    <input
                        data-pool-search
                        ref={(el) => (inputEl = el)}
                        value={props.query}
                        disabled={props.turn === null}
                        onInput={(e) => props.onQueryChange(e.currentTarget.value)}
                        onKeyDown={onKey}
                        placeholder="type a champion…"
                        class="w-[260px] rounded-md border border-sky-300/70 bg-darius-bg px-2 py-1 text-sm text-slate-50 outline-none focus:border-sky-300 disabled:opacity-50"
                    />
                    <Show when={single()}>
                        {(text) => (
                            <span
                                data-single-match
                                class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400"
                            >
                                {text()}
                            </span>
                        )}
                    </Show>
                </span>
                <span class="text-[10px] text-slate-500">
                    type anywhere · ↵ {verb().replace(/s$/, "")} · ⇧↵ explore · esc clear
                </span>
                <Show when={hint()}>
                    {(text) => (
                        <span data-pool-hint class="text-[11px] text-amber-300">
                            {text()}
                        </span>
                    )}
                </Show>
                <For each={collected()}>
                    {(id) => (
                        <span
                            data-pair-chip={id}
                            class="flex items-center gap-1 rounded-full border border-sky-300/70 px-2 py-0.5 text-[11px] text-slate-100"
                        >
                            {nameOf(id)}
                            <button
                                type="button"
                                data-pair-chip-remove
                                aria-label={`Remove ${nameOf(id)}`}
                                onClick={() => setCollected([])}
                                class="text-slate-400 hover:text-slate-100"
                            >
                                ✕
                            </button>
                        </span>
                    )}
                </For>
                <span class="ml-auto flex items-center gap-1 rounded-md border border-darius-border p-0.5">
                    <For each={VIEWS}>
                        {(v) => (
                            <button
                                type="button"
                                data-pool-view-button={v.id}
                                aria-pressed={props.view === v.id ? "true" : "false"}
                                onClick={() => props.onViewChange(v.id)}
                                class={`rounded px-2 py-0.5 text-[11px] ${props.view === v.id ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:text-slate-100"}`}
                            >
                                {v.label}
                            </button>
                        )}
                    </For>
                </span>
                <span
                    data-pool-legend
                    class="flex items-center gap-2 text-[10px] text-slate-400"
                >
                    <For each={ROLES}>
                        {(role) => (
                            <span class="flex items-center gap-1">
                                <i
                                    class="inline-block h-2 w-2 rounded-full"
                                    style={{ background: ROLE_HEX[role] }}
                                />
                                {role === "top"
                                    ? "Top"
                                    : role === "jungle"
                                      ? "Jg"
                                      : role === "mid"
                                        ? "Mid"
                                        : role === "adc"
                                          ? "ADC"
                                          : "Sup"}
                            </span>
                        )}
                    </For>
                </span>
            </div>

            <Show when={poolEmpty()}>
                <div class="flex items-center gap-2 text-xs text-slate-400">
                    This side has no pool yet.
                    <button
                        type="button"
                        data-pool-edit
                        disabled={!props.canEditPools}
                        title={props.canEditPools ? "Edit pools" : "between games"}
                        onClick={() => props.onEditPools()}
                        class="rounded border border-darius-border px-2 py-0.5 text-xs text-slate-200 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Edit pools
                    </button>
                </div>
            </Show>

            <div class="custom-scrollbar grid min-h-0 flex-1 grid-cols-5 gap-1.5 overflow-y-auto">
                <Index each={columns()}>
                    {(column, colIdx) => (
                        <div
                            data-pool-column={column().role}
                            data-lit={column().lit ? "true" : "false"}
                            class={`rounded-md border p-1.5 ${column().lit ? "border-sky-300/50" : "border-darius-border opacity-50"}`}
                        >
                            <div
                                class="mb-1 flex items-center gap-1 text-[10px] font-semibold"
                                style={{ color: ROLE_HEX[column().role] }}
                            >
                                <RoleGlyph role={column().role} />
                                {ROLE_LABELS[column().role]}
                                <span
                                    data-pool-status
                                    class="ml-auto font-normal text-slate-400"
                                >
                                    {statusText(column().status)}
                                </span>
                            </div>
                            <div class="grid grid-cols-4 gap-1">
                                {/* Keyed by champion ID (a string `For` keys by value): poolColumns re-allocates
                                    every PoolTile on each run, and a `For` over the objects would rebuild every
                                    button when the pair chip or the fan changes (memory solidjs_reconcile_stale_hover). */}
                                <For each={column().tiles.map((t) => t.championId)}>
                                    {(id) => {
                                        const tile = () =>
                                            column().tiles.find(
                                                (t) => t.championId === id
                                            );
                                        const isMatch = () =>
                                            matches().size > 0 && matches().has(id);
                                        const dimmed = () =>
                                            matches().size > 0 && !isMatch();
                                        const isHighlighted = () => {
                                            const h = highlight();
                                            return (
                                                h !== null &&
                                                h.col === colIdx &&
                                                highlighted() === id
                                            );
                                        };
                                        const disabled = () =>
                                            tile()?.disabled === true ||
                                            props.turn === null;
                                        const name = () => tile()?.name ?? id;
                                        const rank = () => tile()?.rank ?? null;
                                        const score = () => tile()?.score ?? null;
                                        const reason = () =>
                                            tile()?.disabled
                                                ? props.unavailableReason(id)
                                                : null;
                                        return (
                                            <button
                                                type="button"
                                                data-tile={id}
                                                data-ranked={
                                                    rank() !== null ? "true" : "false"
                                                }
                                                data-match={isMatch() ? "true" : "false"}
                                                data-highlighted={
                                                    isHighlighted() ? "true" : "false"
                                                }
                                                disabled={disabled() || props.committing}
                                                title={
                                                    reason()
                                                        ? `${name()} — ${reason()}`
                                                        : name()
                                                }
                                                onMouseEnter={(e) =>
                                                    setHovered({
                                                        id,
                                                        el: e.currentTarget
                                                    })
                                                }
                                                onMouseLeave={() => setHovered(null)}
                                                onClick={() => choose(id)}
                                                class={`relative aspect-square overflow-hidden rounded border-2 ${tile()?.disabled ? "cursor-not-allowed opacity-20" : dimmed() ? "opacity-[0.18]" : ""} ${isHighlighted() ? "border-sky-300 ring-2 ring-sky-300/40" : isMatch() ? "border-sky-300/70" : rank() !== null ? "border-red-400/70" : "border-darius-border"}`}
                                            >
                                                <img
                                                    src={getChampionImg(id)}
                                                    alt={name()}
                                                    draggable={false}
                                                    class="h-full w-full object-cover"
                                                />
                                                <Show when={score() !== null}>
                                                    <span class="absolute bottom-0 right-0 rounded-tl bg-black/80 px-0.5 text-[9px] font-bold tabular-nums text-slate-50">
                                                        {noSignal()
                                                            ? "—"
                                                            : score()?.toFixed(2)}
                                                    </span>
                                                </Show>
                                            </button>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    )}
                </Index>
            </div>

            <Show when={previewInput()}>
                {(p) => (
                    <Portal>
                        <div
                            data-pool-preview
                            ref={setPreviewEl}
                            class="pointer-events-none fixed z-50 rounded-lg border border-sky-300 bg-darius-card px-2 py-1.5 text-[10px] text-slate-200 shadow-2xl shadow-black/70"
                            style={{
                                left: `${previewPos()?.left ?? 0}px`,
                                top: `${previewPos()?.top ?? 0}px`,
                                visibility: previewPos() ? "visible" : "hidden",
                                width: `${PREVIEW_WIDTH}px`
                            }}
                        >
                            <div class="mb-1">
                                {nameOf(p().id)} → {sideName(p().side)}
                            </div>
                            <SeatRow
                                ids={p().ids}
                                candidateIds={p().candidateIds}
                                beforeIds={p().beforeIds}
                                side={p().side}
                                size="compact"
                                slashCandidate={p().slash}
                            />
                        </div>
                    </Portal>
                )}
            </Show>
        </div>
    );
};
