import { Component, createEffect, createSignal } from "solid-js";
import toast from "solid-toast";
import {
    EMPTY_TEAM_POOL,
    type RolePoolMap,
    type TeamPool
} from "@draft-sim/shared-types";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import { updateNavigatorSession } from "../../utils/navigatorApi";
import { flattenDisplayPool } from "../../utils/navigatorPool";
import { getDefaultRolePoolMap } from "../../utils/defaultRolePools";
import { StyledSelect } from "../StyledSelect";
import { TeamPoolEditor } from "./TeamPoolEditor";

type DraftMode = "standard" | "fearless" | "ironman";

const NavigatorSetup: Component = () => {
    const { navigatorContext, startDraft } = useNavigatorContext();
    const [name, setName] = createSignal("");
    const [ourSide, setOurSide] = createSignal<"blue" | "red">("blue");
    const [draftMode, setDraftMode] = createSignal<DraftMode>("standard");
    const [seriesLength, setSeriesLength] = createSignal<1 | 3 | 5 | 7>(1);
    const [sideSwapMode, setSideSwapMode] = createSignal<"auto" | "manual">(
        "auto"
    );
    const [bluePool, setBluePool] = createSignal<TeamPool>(EMPTY_TEAM_POOL);
    const [redPool, setRedPool] = createSignal<TeamPool>(EMPTY_TEAM_POOL);
    const [isStarting, setIsStarting] = createSignal(false);

    createEffect(() => {
        const session = navigatorContext().session;
        if (!session) return;

        setName(session.name ?? "");
        setOurSide(session.our_side);
        setDraftMode(session.draft_mode);
        setSeriesLength(session.series_length);
        setSideSwapMode(session.side_swap_mode);
        setBluePool(session.blue_pool);
        setRedPool(session.red_pool);
    });

    const updateBlueDisplay = (next: RolePoolMap) => {
        setBluePool((prev) => ({ ...prev, display: next }));
    };

    const updateRedDisplay = (next: RolePoolMap) => {
        setRedPool((prev) => ({ ...prev, display: next }));
    };

    const handleStartDraft = async () => {
        const sessionId = navigatorContext().session?.id;
        if (!sessionId) {
            toast.error("Session not loaded");
            return;
        }

        setIsStarting(true);
        try {
            const derive = (pool: TeamPool): TeamPool => ({
                display: pool.display,
                search: Array.from(new Set(flattenDisplayPool(pool.display)))
            });

            await updateNavigatorSession(sessionId, {
                name: name().trim() || null,
                our_side: ourSide(),
                draft_mode: draftMode(),
                series_length: seriesLength(),
                side_swap_mode: sideSwapMode(),
                blue_pool: derive(bluePool()),
                red_pool: derive(redPool())
            });
            startDraft();
        } catch {
            toast.error("Failed to save navigator setup");
        } finally {
            setIsStarting(false);
        }
    };

    const loadDefaultsForBoth = () => {
        const defaults = getDefaultRolePoolMap();
        setBluePool((prev) => ({ ...prev, display: defaults }));
        setRedPool((prev) => ({ ...prev, display: defaults }));
    };

    return (
        <div class="flex-1 overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto flex min-h-full w-full max-w-[1400px] flex-col p-6 sm:p-8">
                <div class="rounded-xl border border-slate-700/50 bg-slate-800/95 shadow-[0_20px_60px_rgba(15,23,42,0.35)]">
                    <div class="flex flex-col gap-8 p-6 sm:p-8">
                        <section class="flex flex-col gap-5">
                            <div>
                                <h1 class="text-2xl font-bold text-slate-100">Session Config</h1>
                                <p class="mt-1 text-sm text-slate-400">
                                    Configure the session before the draft room opens.
                                </p>
                            </div>

                            <div class="grid gap-4 lg:grid-cols-3 lg:items-end">
                                <label class="block">
                                    <span class="mb-2 block text-sm font-medium text-slate-300">Session Name</span>
                                    <input
                                        type="text"
                                        value={name()}
                                        onInput={(e) => setName(e.currentTarget.value)}
                                        placeholder="Session name (optional)"
                                        class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-blue-400"
                                    />
                                </label>

                                <div class="flex flex-col gap-2">
                                    <span class="text-sm font-medium text-slate-300">
                                        Our Side{seriesLength() > 1 ? " (Game 1)" : ""}
                                    </span>
                                    <div class="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setOurSide("blue")}
                                            class={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                                                ourSide() === "blue"
                                                    ? "border-blue-400 bg-blue-500 text-white"
                                                    : "border-slate-600 bg-transparent text-slate-300 hover:border-blue-400/60 hover:text-slate-100"
                                            }`}
                                        >
                                            Blue Side
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setOurSide("red")}
                                            class={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                                                ourSide() === "red"
                                                    ? "border-red-400 bg-red-500 text-white"
                                                    : "border-slate-600 bg-transparent text-slate-300 hover:border-red-400/60 hover:text-slate-100"
                                            }`}
                                        >
                                            Red Side
                                        </button>
                                    </div>
                                </div>

                                <label class="block">
                                    <span class="mb-2 block text-sm font-medium text-slate-300">Draft Mode</span>
                                    <StyledSelect
                                        value={draftMode()}
                                        onChange={(val) =>
                                            setDraftMode(
                                                val === "fearless"
                                                    ? "fearless"
                                                    : val === "ironman"
                                                      ? "ironman"
                                                      : "standard"
                                            )
                                        }
                                        options={[
                                            { value: "standard", label: "Standard" },
                                            { value: "fearless", label: "Fearless" },
                                            { value: "ironman", label: "Ironman" }
                                        ]}
                                    />
                                </label>
                            </div>

                            <div class="grid gap-4 lg:grid-cols-2 lg:items-end">
                                <label class="block">
                                    <span class="mb-2 block text-sm font-medium text-slate-300">
                                        Series Length
                                    </span>
                                    <StyledSelect
                                        value={String(seriesLength())}
                                        onChange={(val) =>
                                            setSeriesLength(
                                                Number(val) === 1
                                                    ? 1
                                                    : Number(val) === 3
                                                      ? 3
                                                      : Number(val) === 5
                                                        ? 5
                                                        : 7
                                            )
                                        }
                                        options={[
                                            { value: "1", label: "Best of 1" },
                                            { value: "3", label: "Best of 3" },
                                            { value: "5", label: "Best of 5" },
                                            { value: "7", label: "Best of 7" }
                                        ]}
                                    />
                                </label>

                                <label class="block">
                                    <span class="mb-2 block text-sm font-medium text-slate-300">
                                        Side Swap
                                    </span>
                                    <StyledSelect
                                        value={sideSwapMode()}
                                        onChange={(val) =>
                                            setSideSwapMode(
                                                val === "manual" ? "manual" : "auto"
                                            )
                                        }
                                        options={[
                                            {
                                                value: "auto",
                                                label: "Auto (alternate each game)"
                                            },
                                            {
                                                value: "manual",
                                                label: "Manual (choose per game)"
                                            }
                                        ]}
                                        disabled={seriesLength() === 1}
                                    />
                                </label>
                            </div>
                        </section>

                        <section class="flex flex-col gap-4 border-t border-slate-700/60 pt-8">
                            <div class="flex items-center justify-between">
                                <div>
                                    <h2 class="text-xl font-semibold text-slate-100">Team Pools</h2>
                                    <p class="mt-1 text-sm text-slate-400">
                                        Role-structured champion pools per team. Engine biases toward these.
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={loadDefaultsForBoth}
                                    class="text-xs text-slate-400 underline hover:text-slate-200"
                                >
                                    Load defaults for both
                                </button>
                            </div>

                            <div class="grid gap-6 lg:grid-cols-2">
                                <TeamPoolEditor
                                    teamColor="blue"
                                    teamLabel="Blue Team"
                                    displayPool={() => bluePool().display}
                                    onDisplayPoolChange={updateBlueDisplay}
                                />
                                <TeamPoolEditor
                                    teamColor="red"
                                    teamLabel="Red Team"
                                    displayPool={() => redPool().display}
                                    onDisplayPoolChange={updateRedDisplay}
                                />
                            </div>
                        </section>

                        <div class="border-t border-slate-700/60 pt-8">
                            <div class="mx-auto w-full max-w-[400px]">
                                <button
                                    type="button"
                                    onClick={handleStartDraft}
                                    disabled={isStarting()}
                                    class="w-full rounded-lg bg-blue-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                                >
                                    {isStarting()
                                        ? "Saving..."
                                        : seriesLength() > 1
                                          ? "Start Game 1"
                                          : "Start Draft"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NavigatorSetup;
