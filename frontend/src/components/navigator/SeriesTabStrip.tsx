import { Component, For } from "solid-js";
import type {
    NavigatorCompletedGame,
    NavigatorDraftData,
    NavigatorSessionData
} from "../../contexts/NavigatorContext";
import {
    getOurSideForGame,
    getProjectedSideForGameNumber
} from "../../utils/navigatorSide";

interface SeriesTabStripProps {
    session: NavigatorSessionData;
    activeDraft: NavigatorDraftData | null;
    completedGames: NavigatorCompletedGame[];
    viewingGameNumber: number | null;
    onViewGame: (gameNumber: number | null) => void;
}

type TabStatus = "not-started" | "active" | "completed";

interface TabInfo {
    gameNumber: number;
    status: TabStatus;
    side: "blue" | "red" | null;
}

const STATUS_GLYPH: Record<TabStatus, string> = {
    "not-started": "○", // ○
    active: "●", // ●
    completed: "✓" // ✓
};

const sideClass = (side: "blue" | "red" | null): string => {
    if (side === "blue") return "text-blue-300";
    if (side === "red") return "text-red-300";
    return "text-slate-500";
};

export const SeriesTabStrip: Component<SeriesTabStripProps> = (props) => {
    const tabs = (): TabInfo[] => {
        const out: TabInfo[] = [];
        const activeGame = props.activeDraft?.game_number ?? null;
        for (let n = 1; n <= props.session.series_length; n++) {
            const completed = props.completedGames.find((c) => c.draft.game_number === n);
            let status: TabStatus;
            let side: "blue" | "red" | null = null;

            if (completed) {
                status = "completed";
                side = getOurSideForGame(props.session, completed.draft);
            } else if (activeGame === n) {
                status = "active";
                side = props.activeDraft
                    ? getOurSideForGame(props.session, props.activeDraft)
                    : null;
            } else {
                status = "not-started";
                if (props.session.side_swap_mode === "auto") {
                    side = getProjectedSideForGameNumber(props.session, n);
                }
            }

            out.push({ gameNumber: n, status, side });
        }
        return out;
    };

    const isSelected = (tab: TabInfo): boolean => {
        if (props.viewingGameNumber === tab.gameNumber) return true;
        if (
            props.viewingGameNumber === null &&
            tab.gameNumber === props.activeDraft?.game_number
        ) {
            return true;
        }
        return false;
    };

    const handleClick = (tab: TabInfo) => {
        if (tab.status === "not-started") return;
        if (tab.status === "active") {
            props.onViewGame(null);
            return;
        }
        props.onViewGame(tab.gameNumber);
    };

    return (
        <div class="flex items-stretch border-b border-slate-700/50 bg-slate-900/40">
            <For each={tabs()}>
                {(tab) => (
                    <button
                        type="button"
                        onClick={() => handleClick(tab)}
                        disabled={tab.status === "not-started"}
                        class={`flex min-w-[140px] flex-col items-start gap-1 px-4 py-3 text-left transition-colors ${
                            isSelected(tab)
                                ? "border-b-2 border-slate-100 bg-slate-800/80 text-slate-100"
                                : tab.status === "not-started"
                                  ? "cursor-not-allowed text-slate-500"
                                  : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
                        }`}
                    >
                        <span class="flex items-center gap-2 text-sm font-semibold">
                            <span aria-hidden>{STATUS_GLYPH[tab.status]}</span>
                            Game {tab.gameNumber}
                        </span>
                        <span class={`text-xs font-medium ${sideClass(tab.side)}`}>
                            {tab.side ? (tab.side === "blue" ? "Blue" : "Red") : "TBD"}
                        </span>
                        <span class="text-[11px] uppercase tracking-[0.14em] text-slate-500">
                            {tab.status === "active"
                                ? "Active"
                                : tab.status === "completed"
                                  ? "Completed"
                                  : "Not started"}
                        </span>
                    </button>
                )}
            </For>
        </div>
    );
};
