import { Component } from "solid-js";
import {
    formatEngineStatus,
    isHeartbeatStale,
    type EngineStatus
} from "../../utils/navigatorEngineStatus";

const TONE: Record<EngineStatus["kind"], string> = {
    initial: "border-slate-600 text-slate-300",
    complete: "border-slate-600 text-slate-300",
    thinking: "border-amber-500/60 bg-amber-950/40 text-amber-300",
    ready: "border-emerald-600/60 bg-emerald-950/40 text-emerald-300",
    empty: "border-red-600/70 bg-red-950/40 text-red-300",
    failed: "border-red-600/70 bg-red-950/40 text-red-300"
};
const STALE_TONE = "border-red-500/70 bg-red-950/40 text-red-300";

/** Design § 4: one pill, always present during an active draft. A thinking
 *  pill with no heartbeat for HEARTBEAT_STALE_MS turns red (design § 4
 *  honesty clause). */
export const EngineStatusPill: Component<{ status: EngineStatus }> = (props) => (
    <span
        data-engine-status={props.status.kind}
        data-heartbeat-stale={isHeartbeatStale(props.status) ? "true" : "false"}
        class={`whitespace-nowrap rounded-full border px-3 py-1 text-xs tabular-nums ${isHeartbeatStale(props.status) ? STALE_TONE : TONE[props.status.kind]}`}
        title={formatEngineStatus(props.status)}
    >
        {formatEngineStatus(props.status)}
    </span>
);
