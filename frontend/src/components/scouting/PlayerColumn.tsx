import { Component } from "solid-js";
import type { PlayerScoutResult } from "@draft-sim/shared-types";
import { PlayerSummaryHeader, ChampListSection } from "./PlayerPanel";

interface PlayerColumnProps {
    result: PlayerScoutResult;
}

const PlayerColumn: Component<PlayerColumnProps> = (props) => (
    <section class="flex w-[232px] shrink-0 flex-col rounded-xl border border-slate-700/50 bg-slate-800/95">
        <PlayerSummaryHeader result={props.result} />
        <ChampListSection result={props.result} />
    </section>
);

export default PlayerColumn;
