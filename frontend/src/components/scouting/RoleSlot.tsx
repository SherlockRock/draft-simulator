import { Component, Show } from "solid-js";
import type { PlayerScoutResult, Role } from "@draft-sim/shared-types";
import { dragPayload, parseDragPayload, type DragOrigin } from "../../utils/lineupMove";
import { ROLE_LABELS } from "../../utils/championRoles";
import { PlayerSummaryHeader, ChampListSection, RoleIcon } from "./PlayerPanel";

export type MatchupSide = "you" | "enemy";

// Row-ref registry key: one flat map for the whole matchup view lets flex
// strips scroll to rows in ANY column, not just their own.
export const rowRefKey = (side: MatchupSide, role: Role, championId: string): string =>
    `${side}:${role}:${championId}`;

export const HALF_LIST_MAX = "max-h-[26vh]";

interface HalfProps {
    side: MatchupSide;
    role: Role;
    result: PlayerScoutResult | null;
    rowRefs: Map<string, HTMLDivElement>;
    highlight: Set<string>;
    pulse: { keys: Set<string> } | null;
    maxHeightClass?: string;
}

const PlayerHalf: Component<HalfProps> = (props) => (
    <Show
        when={props.result}
        fallback={
            <div class="flex min-h-[80px] flex-1 items-center justify-center p-3 text-xs text-slate-500">
                No player assigned
            </div>
        }
    >
        {(result) => {
            const pulseId = () => {
                const p = props.pulse;
                if (!p) return null;
                const prefix = `${props.side}:${props.role}:`;
                for (const key of p.keys) {
                    if (key.startsWith(prefix)) return key.slice(prefix.length);
                }
                return null;
            };
            return (
                <div class="flex min-h-0 flex-1 flex-col">
                    <PlayerSummaryHeader result={result()} />
                    <ChampListSection
                        result={result()}
                        maxHeightClass={props.maxHeightClass}
                        highlightSet={props.highlight}
                        pulseChampionId={pulseId()}
                        onRowRef={(championId, el) =>
                            props.rowRefs.set(
                                rowRefKey(props.side, props.role, championId),
                                el
                            )
                        }
                    />
                </div>
            );
        }}
    </Show>
);

interface DraggableHalfProps extends HalfProps {
    /**
     * Whether the ROLE SLOT holds a player — which is not the same as having a
     * scout row. Gating the drag on `result` would make a starter undraggable
     * after a batch-level u.gg failure, so demotion would be unreachable in
     * exactly the state the bench stays visible for.
     */
    occupied?: boolean;
    onMove?: (side: MatchupSide, from: DragOrigin, to: DragOrigin) => void;
}

export const DraggableHalf: Component<DraggableHalfProps> = (props) => {
    const canDrag = () => props.occupied ?? props.result !== null;
    const self = (): DragOrigin => ({ kind: "slot", role: props.role });
    return (
        <div
            draggable={canDrag()}
            onDragStart={(e) => {
                if (!canDrag()) return;
                e.dataTransfer?.setData("text/plain", dragPayload(props.side, self()));
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                const raw = e.dataTransfer?.getData("text/plain");
                if (!raw) return;
                const parsed = parseDragPayload(raw);
                if (!parsed) return;
                if (parsed.side !== props.side) return;
                props.onMove?.(props.side, parsed.origin, self());
            }}
            class="flex min-h-0 flex-1 flex-col"
            classList={{ "cursor-grab": canDrag() }}
        >
            <PlayerHalf
                side={props.side}
                role={props.role}
                result={props.result}
                rowRefs={props.rowRefs}
                highlight={props.highlight}
                pulse={props.pulse}
                maxHeightClass={props.maxHeightClass}
            />
        </div>
    );
};

export const RoleHeader: Component<{ role: Role }> = (props) => (
    <div class="flex items-center justify-center gap-1.5 border-b border-slate-700/60 py-1.5">
        <RoleIcon role={props.role} active class="h-3.5 w-3.5" />
        <span class="text-xs font-semibold uppercase tracking-wide text-slate-300">
            {ROLE_LABELS[props.role]}
        </span>
    </div>
);
