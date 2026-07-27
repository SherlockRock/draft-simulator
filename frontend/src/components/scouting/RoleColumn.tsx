import { Component } from "solid-js";
import type { PlayerScoutResult, Role } from "@draft-sim/shared-types";
import { DraggableHalf, RoleHeader, type MatchupSide } from "./RoleSlot";
import type { DragOrigin } from "../../utils/lineupMove";
import type { PlayerId } from "../../utils/playerStats";

interface RoleColumnProps {
    role: Role;
    result: PlayerScoutResult | null;
    /** Whether the slot holds a player — see DraggableHalf. */
    occupied?: boolean;
    rowRefs: Map<string, HTMLDivElement>;
    /** Single-team scouting has nothing to compare against, so this is optional. */
    highlight?: Set<string>;
    pulse: { keys: Set<string> } | null;
    onMove?: (side: MatchupSide, from: DragOrigin, to: DragOrigin) => void;
    onRefresh?: (side: MatchupSide, player: PlayerId) => void;
    busy?: boolean;
}

// Solid compiles JSX props to getters, so an inline `new Set()` default would
// allocate on every read, and ChampListSection reads highlightSet once per
// champion row — hoist a single shared empty set instead.
const NO_HIGHLIGHT: Set<string> = new Set();

// Single-team counterpart to MatchupColumn. MatchupColumn is welded to the
// two-half shape by its shared-champs divider, so reusing it with enemy={null}
// would render a dead "no shared champs" strip under every column.
export const RoleColumn: Component<RoleColumnProps> = (props) => (
    <section class="flex w-[232px] shrink-0 flex-col rounded-xl border border-slate-700/50 bg-slate-800/95">
        <RoleHeader role={props.role} />
        <DraggableHalf
            side="you"
            role={props.role}
            result={props.result}
            occupied={props.occupied}
            rowRefs={props.rowRefs}
            highlight={props.highlight ?? NO_HIGHLIGHT}
            pulse={props.pulse}
            onMove={props.onMove}
            onRefresh={props.onRefresh}
            busy={props.busy}
        />
    </section>
);
