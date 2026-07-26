import { Component } from "solid-js";
import type { PlayerScoutResult, Role } from "@draft-sim/shared-types";
import { DraggableHalf, RoleHeader, type MatchupSide } from "./RoleSlot";

interface RoleColumnProps {
    role: Role;
    result: PlayerScoutResult | null;
    rowRefs: Map<string, HTMLDivElement>;
    highlight: Set<string>;
    pulse: { keys: Set<string> } | null;
    onSwap?: (side: MatchupSide, from: Role, to: Role) => void;
}

// Solid compiles JSX props to getters, so an inline `new Set()` at each call
// site would allocate on every read, and ChampListSection reads highlightSet
// once per champion row — hoist a single shared empty set instead.
export const NO_HIGHLIGHT: Set<string> = new Set();

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
            rowRefs={props.rowRefs}
            highlight={props.highlight}
            pulse={props.pulse}
            onSwap={props.onSwap}
        />
    </section>
);
