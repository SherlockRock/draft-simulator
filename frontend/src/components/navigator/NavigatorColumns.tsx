import { Component, For, Index, Show, createMemo } from "solid-js";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { getChampionImg } from "../../utils/championRoles";
import { resolveChampion } from "../../utils/constants";
import {
    banSignalAbsent,
    NO_BAN_SIGNAL_LABEL,
    type ColumnModel
} from "../../utils/navigatorColumns";
import { turnLabelForSlots } from "../../utils/turnSequence";

export interface NodeRoleLine {
    /** One formatted label per node champion ("Sup"). */
    roles: string[];
    /** "Sylas → Sup" when the pick moves an earlier pick (design § 2), else null. */
    shift: string | null;
}

export interface NavigatorColumnsProps {
    columns: ColumnModel[];
    ourSide: "blue" | "red";
    dimmed: boolean;
    canMutate: boolean;
    emptyReason: string | null;
    canEditPools: boolean;
    /** False at zero confirmed events — the server rejects an undo. */
    canUndo: boolean;
    roleLineFor: (node: NavigatorTreeNode, column: ColumnModel) => NodeRoleLine;
    onSelect: (depth: number, index: number) => void;
    onCommit: (node: NavigatorTreeNode) => void;
    onContextMenu: (args: {
        node: NavigatorTreeNode;
        depth: number;
        index: number;
        x: number;
        y: number;
    }) => void;
    onUndo: () => void;
    onEditPools: () => void;
}

const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;
const namesOf = (ids: readonly string[]): string => ids.map(nameOf).join(" + ");

const Portrait: Component<{
    id: string;
    side: "blue" | "red" | null;
    ban: boolean;
    confirmedHalf: boolean;
}> = (props) => (
    <span
        data-confirmed-half={props.confirmedHalf ? "true" : "false"}
        class={`relative inline-block h-8 w-8 ${props.confirmedHalf ? "opacity-60" : ""}`}
        title={props.confirmedHalf ? `${nameOf(props.id)} (confirmed)` : nameOf(props.id)}
    >
        <img
            src={getChampionImg(props.id)}
            alt={nameOf(props.id)}
            draggable={false}
            class={`h-full w-full rounded-full border-2 object-cover ${props.side === "blue" ? "border-blue-400" : "border-red-400"} ${props.ban ? "opacity-50 grayscale" : ""}`}
        />
        <Show when={props.ban}>
            <span
                class={`absolute left-1 right-1 top-1/2 h-0.5 -rotate-45 ${props.side === "blue" ? "bg-blue-300" : "bg-red-400"}`}
            />
        </Show>
    </span>
);

/** Design § 2: column 0 = the ranked fan; column k = children of the node
 *  selected in column k−1. Design § 4: the empty-fan card. */
export const NavigatorColumns: Component<NavigatorColumnsProps> = (props) => {
    const header = (column: ColumnModel): string => {
        const first = column.nodes[0];
        const label = first ? turnLabelForSlots(first.slots) : "";
        const you = first && first.side === props.ourSide ? " — you" : "";
        return `${label}${you}`;
    };
    const forLabel = (column: ColumnModel): string | null => {
        const parent = column.lineage[column.lineage.length - 1];
        return parent ? `· for ${namesOf(parent.championIds)}` : null;
    };

    return (
        <div class="custom-scrollbar grid min-h-0 flex-1 auto-cols-[300px] grid-flow-col gap-4 overflow-x-auto px-4 py-4">
            <Show when={props.columns.length === 0 && props.emptyReason !== null}>
                <div
                    data-empty-fan
                    class="max-w-md self-start rounded-lg border border-red-700/60 bg-red-950/30 p-4 text-sm text-red-200"
                >
                    <div class="mb-1 font-semibold">
                        The engine found no legal completion.
                    </div>
                    <div class="text-red-300/90">{props.emptyReason}</div>
                    <div class="mt-3 flex gap-2">
                        <button
                            type="button"
                            data-remedy="undo"
                            disabled={!props.canUndo}
                            title={
                                props.canUndo ? "Undo the last pick" : "nothing to undo"
                            }
                            onClick={() => props.onUndo()}
                            class="rounded border border-darius-border px-2 py-1 text-xs text-slate-200 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Undo the last pick
                        </button>
                        <button
                            type="button"
                            data-remedy="pools"
                            disabled={!props.canEditPools}
                            title={props.canEditPools ? "Edit pools" : "between games"}
                            onClick={() => props.onEditPools()}
                            class="rounded border border-darius-border px-2 py-1 text-xs text-slate-200 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Widen the pool
                        </button>
                    </div>
                </div>
            </Show>
            {/* `Index`, not `For`: `columns` is re-allocated on every selection/snapshot (deriveColumns builds fresh objects) — `For` would rebuild every card, and the CSS-hover Pick button under the cursor would vanish (memory solidjs_reconcile_stale_hover). Depth is the identity. */}
            <Index each={props.columns}>
                {(column) => (
                    <div
                        data-column
                        data-depth={column().depth}
                        class={`flex flex-col gap-2 ${props.dimmed ? "opacity-50" : ""}`}
                    >
                        <div class="text-[10px] uppercase tracking-wider text-slate-400">
                            {header(column())}
                            <Show when={forLabel(column())}>
                                {(text) => (
                                    <span class="normal-case text-slate-500">
                                        {" "}
                                        {text()}
                                    </span>
                                )}
                            </Show>
                        </div>
                        <For each={column().nodes}>
                            {(node, i) => {
                                const selected = () => column().selectedIndex === i();
                                const ghost = () =>
                                    column().selectedIndex !== null && !selected();
                                // Memoised: each call runs two P(5,n) solves (up to 240 permutations).
                                const line = createMemo(() =>
                                    props.roleLineFor(node, column())
                                );
                                const confirmed = new Set(
                                    node.confirmedChampionIds ?? []
                                );
                                return (
                                    <div
                                        data-column-node
                                        data-rank={i() + 1}
                                        data-selected={selected() ? "true" : "false"}
                                        data-ghost={ghost() ? "true" : "false"}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() =>
                                            props.onSelect(column().depth, i())
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter")
                                                props.onSelect(column().depth, i());
                                        }}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            props.onContextMenu({
                                                node,
                                                depth: column().depth,
                                                index: i(),
                                                x: e.clientX,
                                                y: e.clientY
                                            });
                                        }}
                                        class={`group relative flex cursor-pointer items-center gap-2 rounded-lg border bg-darius-card px-2 py-1.5 transition ${node.side === "blue" ? "border-blue-500/70" : "border-red-500/70"} ${selected() ? "ring-2 ring-sky-300" : ""} ${ghost() ? "opacity-35 hover:opacity-80" : ""}`}
                                    >
                                        <span
                                            class={`absolute -left-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${selected() ? "bg-sky-300 text-black" : "bg-slate-700 text-slate-100"}`}
                                        >
                                            {i() + 1}
                                        </span>
                                        <For each={node.championIds}>
                                            {(id, k) => (
                                                <span class={k() > 0 ? "-ml-3" : ""}>
                                                    <Portrait
                                                        id={id}
                                                        side={node.side}
                                                        ban={node.actionType === "ban"}
                                                        confirmedHalf={confirmed.has(id)}
                                                    />
                                                </span>
                                            )}
                                        </For>
                                        <div class="min-w-0 flex-1">
                                            <div class="truncate text-xs font-semibold text-slate-50">
                                                {namesOf(node.championIds)}
                                                <Show when={node.userInjected}>
                                                    <span
                                                        data-pinned
                                                        title="Pinned by you"
                                                        class="ml-1 text-[10px] text-amber-300"
                                                    >
                                                        pinned
                                                    </span>
                                                </Show>
                                            </div>
                                            <div class="truncate text-[11px] text-slate-400">
                                                <span data-node-role>
                                                    {node.actionType === "ban"
                                                        ? "ban"
                                                        : line().roles.join(" · ")}
                                                </span>
                                                <Show
                                                    when={
                                                        node.actionType === "pick" &&
                                                        line().shift
                                                    }
                                                >
                                                    {(shift) => (
                                                        <span
                                                            data-node-shift
                                                            class="text-amber-300"
                                                        >
                                                            {" "}
                                                            · {shift()}
                                                        </span>
                                                    )}
                                                </Show>
                                            </div>
                                        </div>
                                        <Show
                                            when={!banSignalAbsent(column().nodes)}
                                            fallback={
                                                <span
                                                    data-no-ban-signal
                                                    class="text-[11px] italic text-slate-500"
                                                >
                                                    {NO_BAN_SIGNAL_LABEL}
                                                </span>
                                            }
                                        >
                                            <span
                                                data-node-score
                                                class="text-sm font-bold tabular-nums text-slate-50"
                                            >
                                                {node.scores.composite.toFixed(2)}
                                            </span>
                                        </Show>
                                        <Show
                                            when={column().depth === 0 && props.canMutate}
                                        >
                                            <button
                                                type="button"
                                                data-commit={node.actionType}
                                                class="absolute -top-3 right-1 hidden rounded bg-sky-300 px-2 py-0.5 text-[10px] font-bold text-black group-hover:block"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    props.onCommit(node);
                                                }}
                                            >
                                                {node.actionType === "ban"
                                                    ? "Ban"
                                                    : "Pick"}
                                            </button>
                                        </Show>
                                    </div>
                                );
                            }}
                        </For>
                        <Show
                            when={
                                column().depth === 0 &&
                                column().selectedIndex === null &&
                                column().nodes.some((n) => n.children.length > 0)
                            }
                        >
                            <div class="text-[11px] text-slate-500">
                                Click a candidate to open its line →
                            </div>
                        </Show>
                    </div>
                )}
            </Index>
        </div>
    );
};
