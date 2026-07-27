import { Component, Show, createMemo } from "solid-js";
import type { PlayerScoutResult, Role } from "@draft-sim/shared-types";
import { computeSharedChamps } from "../../utils/playerStats";
import { ChampChipStrip, type ChipDetail } from "./ChampChipStrip";
import { DraggableHalf, RoleHeader, HALF_LIST_MAX, type MatchupSide } from "./RoleSlot";
import type { DragOrigin } from "../../utils/lineupMove";
import type { PlayerId } from "../../utils/playerStats";

const entriesOf = (r: PlayerScoutResult | null) =>
    r && r.status === "ok" ? r.envelope.entries : [];

const riotIdOf = (r: PlayerScoutResult): string =>
    `${r.input.gameName}#${r.input.tagLine}`;

interface MatchupColumnProps {
    role: Role;
    you: PlayerScoutResult | null;
    enemy: PlayerScoutResult | null;
    rowRefs: Map<string, HTMLDivElement>;
    highlightYou: Set<string>;
    highlightEnemy: Set<string>;
    pulse: { keys: Set<string> } | null;
    onChipClick: (side: MatchupSide, role: Role, championId: string) => void;
    /** Whether each side's slot holds a player — see DraggableHalf. */
    youOccupied?: boolean;
    enemyOccupied?: boolean;
    onMove?: (side: MatchupSide, from: DragOrigin, to: DragOrigin) => void;
    onRefresh?: (side: MatchupSide, player: PlayerId) => void;
    /** Per side: each half's refresh disables while ITS side has a batch out. */
    youBusy?: boolean;
    enemyBusy?: boolean;
}

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
            <RoleHeader role={props.role} />
            <DraggableHalf
                side="you"
                role={props.role}
                result={props.you}
                occupied={props.youOccupied}
                rowRefs={props.rowRefs}
                highlight={props.highlightYou}
                pulse={props.pulse}
                maxHeightClass={HALF_LIST_MAX}
                onMove={props.onMove}
                onRefresh={props.onRefresh}
                busy={props.youBusy}
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
                occupied={props.enemyOccupied}
                rowRefs={props.rowRefs}
                highlight={props.highlightEnemy}
                pulse={props.pulse}
                maxHeightClass={HALF_LIST_MAX}
                onMove={props.onMove}
                onRefresh={props.onRefresh}
                busy={props.enemyBusy}
            />
        </section>
    );
};
