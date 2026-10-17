import { Component, For, createSignal } from "solid-js";
import type { NavigatorEventData } from "../../contexts/NavigatorContext";
import item5 from "../../utils/__fixtures__/navigator-item5-shares-snapshot.json";
import { seatMarginals } from "../../utils/navigatorSeats";
import { TURN_SEQUENCE } from "../../utils/turnSequence";
import { NavigatorTeamColumn } from "../../components/navigator/NavigatorTeamColumn";
import { SeatRing } from "../../components/navigator/SeatRing";
import { SeatRow } from "../../components/navigator/SeatRow";

// THROWAWAY (design § 9): the ten stress states and the item5 lobby on the real SeatRing /
// SeatRow / NavigatorTeamColumn, with knobs for the ring geometry; the middle pane of section C is
// a static stand-in (8 card boxes over a 5×24 tile grid) so the 1400×900 height split can be judged
// before the cutover. Data = the committed fixtures, not the dev DB (plan-level decision 17).
// Deleted by the plan's last task.

const STATES: {
    label: string;
    ids: string[];
    candidateIds?: string[];
    side: "blue" | "red";
}[] = [
    {
        label: "1 · Brand alone (Blue Pick 1)",
        ids: ["Brand"],
        candidateIds: ["Brand"],
        side: "blue"
    },
    {
        label: "2 · Diana + Ekko (swap pair)",
        ids: ["Diana", "Ekko"],
        candidateIds: ["Ekko"],
        side: "blue"
    },
    {
        label: "3 · Poppy + Tahm Kench + Neeko (three-way)",
        ids: ["Poppy", "TahmKench", "Neeko"],
        candidateIds: ["Neeko"],
        side: "red"
    },
    {
        label: "4 · Red tour five",
        ids: ["Sejuani", "Sylas", "Lissandra", "Tristana", "Pantheon"],
        side: "red"
    },
    {
        label: "5 · Aphelios moves Ashe to support",
        ids: ["Ashe", "AurelionSol", "Aphelios"],
        candidateIds: ["Aphelios"],
        side: "red"
    },
    {
        label: "6 · Blue three (certain beside uncertain)",
        ids: ["Gragas", "Hecarim", "Akali"],
        side: "blue"
    },
    { label: "7 · Infeasible: Jinx + Aphelios", ids: ["Jinx", "Aphelios"], side: "red" },
    {
        label: "8 · Pair pick: Xayah + Shen",
        ids: ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"],
        candidateIds: ["Xayah", "Shen"],
        side: "blue"
    },
    { label: "9 · Empty board", ids: [], side: "red" },
    {
        label: "10 · Messy five",
        ids: ["Poppy", "TahmKench", "Neeko", "Jinx", "Diana"],
        side: "blue"
    }
];

function events(order: readonly string[]): NavigatorEventData[] {
    return order.map((champion_id, slot) => ({
        id: `p${slot}`,
        navigator_draft_id: "prototype",
        event_type: TURN_SEQUENCE[slot].type,
        slot,
        side: TURN_SEQUENCE[slot].side,
        champion_id,
        user_injected: false,
        createdAt: new Date(1700000000000 + slot).toISOString()
    }));
}
const TOUR = item5.events;
const RED_PICK_3 = [
    "Caitlyn",
    "Twitch",
    "Draven",
    "Jhin",
    "Zeri",
    "Kaisa",
    "Gragas",
    "Jinx",
    "Ashe",
    "Hecarim",
    "Akali"
];

const NavigatorLobbyPrototype: Component = () => {
    const [ring, setRing] = createSignal(4);
    const [portrait, setPortrait] = createSignal(34);
    const [state, setState] = createSignal<"tour" | "redPick3">("redPick3");
    const order = () => (state() === "tour" ? TOUR : RED_PICK_3);
    const asheDist = () => seatMarginals(["Jinx", "Ashe"]).get("Ashe") ?? null;
    return (
        <div class="custom-scrollbar h-full w-full overflow-auto bg-darius-bg p-6 text-slate-50">
            <h1 class="text-lg font-bold">Navigator lobby prototype (throwaway)</h1>
            <div class="mt-3 flex items-center gap-6 text-xs">
                <label>
                    ring {ring()}px
                    <input
                        type="range"
                        min="2"
                        max="6"
                        value={ring()}
                        onInput={(e) => setRing(Number(e.currentTarget.value))}
                        class="ml-2"
                    />
                </label>
                <label>
                    portrait {portrait()}px
                    <input
                        type="range"
                        min="26"
                        max="46"
                        value={portrait()}
                        onInput={(e) => setPortrait(Number(e.currentTarget.value))}
                        class="ml-2"
                    />
                </label>
                <label>
                    board state
                    <select
                        value={state()}
                        onChange={(e) =>
                            setState(
                                e.currentTarget.value === "tour" ? "tour" : "redPick3"
                            )
                        }
                        class="ml-2 bg-darius-card"
                    >
                        <option value="redPick3">Red Pick 3 (Jinx + Ashe)</option>
                        <option value="tour">Tour state (Red Pick 5)</option>
                    </select>
                </label>
            </div>

            <h2 class="mt-6 text-sm font-semibold text-slate-300">
                A · Ring geometry (Ashe at Jinx + Ashe)
            </h2>
            <div class="mt-2 flex items-end gap-6">
                <For each={[22, 26, 30, 34, 42]}>
                    {(size) => (
                        <div class="flex flex-col items-center gap-1 text-[10px] text-slate-400">
                            <SeatRing
                                championId="Ashe"
                                dist={asheDist()}
                                size={size - 2 * ring()}
                                ring={ring()}
                                side="red"
                                marker={size === 30 ? "candidate" : "none"}
                            />
                            {size}px
                        </div>
                    )}
                </For>
                <div class="flex flex-col items-center gap-1 text-[10px] text-slate-400">
                    <SeatRing
                        championId="Ashe"
                        dist={asheDist()}
                        size={portrait()}
                        ring={ring()}
                        side="red"
                        marker="moved"
                    />
                    knob
                </div>
            </div>

            <h2 class="mt-6 text-sm font-semibold text-slate-300">
                B · The ten stress states (card size, then compact)
            </h2>
            <div class="mt-2 grid grid-cols-2 gap-4">
                <For each={STATES}>
                    {(s) => (
                        <div class="rounded-lg border border-darius-border bg-darius-card p-3">
                            <div class="mb-2 text-[11px] text-slate-400">{s.label}</div>
                            <SeatRow
                                ids={s.ids}
                                candidateIds={s.candidateIds}
                                side={s.side}
                                size="card"
                                infeasibleText="✕ cannot fill five roles"
                            />
                            <div class="mt-2">
                                <SeatRow
                                    ids={s.ids}
                                    candidateIds={s.candidateIds}
                                    side={s.side}
                                    size="compact"
                                    infeasibleText="✕ cannot fill five roles"
                                />
                            </div>
                        </div>
                    )}
                </For>
            </div>

            <h2 class="mt-6 text-sm font-semibold text-slate-300">
                C · Lobby proportions at 1400×900 (230px team columns, real data; the
                middle is a static stand-in for Tasks 5–8)
            </h2>
            <div class="mt-2 flex h-[600px] w-[1400px] flex-col rounded-lg border border-darius-border bg-darius-card">
                <div class="flex items-center gap-4 border-b border-darius-border/60 px-4 py-2 text-xs text-slate-300">
                    <span class="min-w-0 truncate font-semibold">
                        Pick Phase 1 — Red Pick 3 · red on the clock · you
                    </span>
                    <span class="shrink-0 text-slate-500">[20 ticks]</span>
                    <span class="ml-auto flex shrink-0 gap-2">
                        <span class="rounded-full border border-emerald-600/60 px-3 py-1">
                            ● 5 candidates · depth 5 · 3998 ms
                        </span>
                        <span class="rounded-full border border-amber-500/60 px-3 py-1">
                            ⚠ Saved pool uses old role buckets · re-bucket
                        </span>
                        <span class="rounded-full border border-darius-border px-3 py-1">
                            Undo
                        </span>
                        <span class="rounded-full border border-darius-border px-3 py-1">
                            Command /
                        </span>
                    </span>
                </div>
                <div class="flex min-h-0 flex-1">
                    <NavigatorTeamColumn
                        side="blue"
                        events={events(order())}
                        ourSide="red"
                        nextSlot={order().length}
                        active={true}
                        onPickNow={() => undefined}
                    />
                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                        <div class="max-h-[55%] shrink-0 overflow-auto px-4 py-4">
                            <div class="flex w-[340px] flex-col gap-2">
                                <For each={[1, 2, 3, 4, 5, 6, 7, 8]}>
                                    {(n) => (
                                        <div class="flex items-center gap-2 rounded-lg border border-red-500/70 bg-darius-card px-2 py-1.5">
                                            <span class="h-8 w-8 rounded-full bg-slate-700" />
                                            <span class="flex-1">
                                                <span class="block text-xs font-semibold">
                                                    Candidate {n}
                                                </span>
                                                <SeatRow
                                                    ids={["Jinx", "Ashe", "Swain"]}
                                                    candidateIds={["Swain"]}
                                                    side="red"
                                                    size="card"
                                                />
                                            </span>
                                            <span class="text-sm font-bold">
                                                2.{90 - n}
                                            </span>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </div>
                        <div class="min-h-0 flex-1 border-t border-darius-border/60 px-3 pt-2">
                            <div class="mb-2 text-[11px] text-sky-300">
                                Red's pool · Pick for Red Pick 3 · [search] · Yours |
                                Enemy | All · legend
                            </div>
                            <div class="grid h-[calc(100%-28px)] grid-cols-5 gap-1.5 overflow-y-auto">
                                <For each={["top", "jungle", "mid", "adc", "support"]}>
                                    {() => (
                                        <div class="rounded-md border border-sky-300/50 p-1.5">
                                            <div class="grid grid-cols-4 gap-1">
                                                <For each={new Array<number>(24).fill(0)}>
                                                    {() => (
                                                        <span class="block aspect-square rounded bg-slate-700/70" />
                                                    )}
                                                </For>
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </div>
                    </div>
                    <NavigatorTeamColumn
                        side="red"
                        events={events(order())}
                        ourSide="red"
                        nextSlot={order().length}
                        active={true}
                        onPickNow={() => undefined}
                    />
                </div>
            </div>
        </div>
    );
};

export default NavigatorLobbyPrototype;
