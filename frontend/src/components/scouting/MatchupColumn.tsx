import { Component, Show, createMemo } from "solid-js";
import type { PlayerScoutResult, Role } from "@draft-sim/shared-types";
import { computeSharedChamps, ROLE_ORDER } from "../../utils/playerStats";
import { ROLE_LABELS } from "../../utils/championRoles";
import { PlayerSummaryHeader, ChampListSection, RoleIcon } from "./PlayerPanel";
import { ChampChipStrip, type ChipDetail } from "./ChampChipStrip";

export type MatchupSide = "you" | "enemy";

// Row-ref registry key: one flat map for the whole matchup view lets flex
// strips scroll to rows in ANY column, not just their own.
export const rowRefKey = (side: MatchupSide, role: Role, championId: string): string =>
    `${side}:${role}:${championId}`;

const HALF_LIST_MAX = "max-h-[26vh]";

const entriesOf = (r: PlayerScoutResult | null) =>
    r && r.status === "ok" ? r.envelope.entries : [];

const riotIdOf = (r: PlayerScoutResult): string =>
    `${r.input.gameName}#${r.input.tagLine}`;

const dragPayload = (side: MatchupSide, role: Role): string => `${side}:${role}`;

const parseDragPayload = (raw: string): { side: MatchupSide; role: Role } | null => {
    const parts = raw.split(":");
    if (parts.length !== 2) return null;
    const side = parts[0] === "you" || parts[0] === "enemy" ? parts[0] : null;
    const role = ROLE_ORDER.find((r) => r === parts[1]) ?? null;
    return side && role ? { side, role } : null;
};

interface HalfProps {
    side: MatchupSide;
    role: Role;
    result: PlayerScoutResult | null;
    rowRefs: Map<string, HTMLDivElement>;
    highlight: Set<string>;
    pulse: { key: string } | null;
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
                return p.key.startsWith(prefix) ? p.key.slice(prefix.length) : null;
            };
            return (
                <div class="flex min-h-0 flex-1 flex-col">
                    <PlayerSummaryHeader result={result()} />
                    <ChampListSection
                        result={result()}
                        maxHeightClass={HALF_LIST_MAX}
                        highlightSet={props.highlight}
                        pulseChampionId={pulseId()}
                        onRowRef={(championId, el) =>
                            props.rowRefs.set(rowRefKey(props.side, props.role, championId), el)
                        }
                    />
                </div>
            );
        }}
    </Show>
);

interface MatchupColumnProps {
    role: Role;
    you: PlayerScoutResult | null;
    enemy: PlayerScoutResult | null;
    rowRefs: Map<string, HTMLDivElement>;
    highlightYou: Set<string>;
    highlightEnemy: Set<string>;
    pulse: { key: string } | null;
    onChipClick: (side: MatchupSide, role: Role, championId: string) => void;
    // Task 8 wires this to role-swap DOM controls.
    onSwap?: (side: MatchupSide, from: Role, to: Role) => void;
}

interface DraggableHalfProps extends HalfProps {
    onSwap?: (side: MatchupSide, from: Role, to: Role) => void;
}

const DraggableHalf: Component<DraggableHalfProps> = (props) => (
    <div
        draggable={props.result !== null}
        onDragStart={(e) => {
            if (!props.result) return;
            e.dataTransfer?.setData("text/plain", dragPayload(props.side, props.role));
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
            e.preventDefault();
            const raw = e.dataTransfer?.getData("text/plain");
            if (!raw) return;
            const parsed = parseDragPayload(raw);
            if (!parsed) return;
            if (parsed.side !== props.side) return;
            if (parsed.role === props.role) return;
            props.onSwap?.(props.side, parsed.role, props.role);
        }}
        class="flex min-h-0 flex-1 flex-col"
        classList={{ "cursor-grab": props.result !== null }}
    >
        <PlayerHalf
            side={props.side}
            role={props.role}
            result={props.result}
            rowRefs={props.rowRefs}
            highlight={props.highlight}
            pulse={props.pulse}
        />
    </div>
);

export const MatchupColumn: Component<MatchupColumnProps> = (props) => {
    const shared = createMemo(() =>
        computeSharedChamps(entriesOf(props.you), entriesOf(props.enemy))
    );
    const chips = createMemo<ChipDetail[]>(() =>
        shared().map((champ) => ({
            kind: "shared",
            champ,
            youName: props.you ? riotIdOf(props.you) : "—",
            enemyName: props.enemy ? riotIdOf(props.enemy) : "—"
        }))
    );

    return (
        <section class="flex w-[232px] shrink-0 flex-col rounded-xl border border-slate-700/50 bg-slate-800/95">
            <div class="flex items-center justify-center gap-1.5 border-b border-slate-700/60 py-1.5">
                <RoleIcon role={props.role} active class="h-3.5 w-3.5" />
                <span class="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    {ROLE_LABELS[props.role]}
                </span>
            </div>
            <DraggableHalf
                side="you"
                role={props.role}
                result={props.you}
                rowRefs={props.rowRefs}
                highlight={props.highlightYou}
                pulse={props.pulse}
                onSwap={props.onSwap}
            />
            {/* Divider: the pool intersection, structurally — no verdicts. */}
            <div class="border-y border-slate-700/60 bg-slate-900/60 px-1.5 py-1">
                <Show
                    when={chips().length > 0}
                    fallback={
                        <div class="py-0.5 text-center text-[10px] text-slate-600">
                            no shared champs
                        </div>
                    }
                >
                    <ChampChipStrip
                        chips={chips()}
                        onChipClick={(championId) => {
                            props.onChipClick("you", props.role, championId);
                            props.onChipClick("enemy", props.role, championId);
                        }}
                    />
                </Show>
            </div>
            <DraggableHalf
                side="enemy"
                role={props.role}
                result={props.enemy}
                rowRefs={props.rowRefs}
                highlight={props.highlightEnemy}
                pulse={props.pulse}
                onSwap={props.onSwap}
            />
        </section>
    );
};
