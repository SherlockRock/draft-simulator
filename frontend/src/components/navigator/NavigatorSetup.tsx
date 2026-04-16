import { Component, createEffect, createMemo, createSignal } from "solid-js";
import toast from "solid-toast";
import { ChampionToggleGrid } from "../ChampionToggleGrid";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import { updateNavigatorSession } from "../../utils/navigatorApi";
import { champions } from "../../utils/constants";

const NavigatorSetup: Component = () => {
    const { navigatorContext, startDraft } = useNavigatorContext();
    const [name, setName] = createSignal("");
    const [ourSide, setOurSide] = createSignal<"blue" | "red">("blue");
    const [fearless, setFearless] = createSignal(false);
    const [displayPool, setDisplayPool] = createSignal<string[]>([]);
    const [isStarting, setIsStarting] = createSignal(false);

    createEffect(() => {
        const session = navigatorContext().session;

        if (session) {
            setName(session.name ?? "");
            setOurSide(session.our_side);
            setFearless(session.fearless);
            setDisplayPool(session.display_pool);
        }
    });

    const searchPool = createMemo(() => {
        const sessionSearchPool = navigatorContext().session?.search_pool ?? [];
        const combinedPool = [...sessionSearchPool, ...displayPool()];
        return Array.from(new Set(combinedPool));
    });

    const toggleChampion = (championId: string) => {
        setDisplayPool((currentPool) =>
            currentPool.includes(championId)
                ? currentPool.filter((id) => id !== championId)
                : [...currentPool, championId]
        );
    };

    const handleStartDraft = async () => {
        const sessionId = navigatorContext().session?.id;

        if (!sessionId) {
            toast.error("Session not loaded");
            return;
        }

        setIsStarting(true);

        try {
            await updateNavigatorSession(sessionId, {
                name: name().trim() || null,
                our_side: ourSide(),
                fearless: fearless(),
                display_pool: displayPool(),
                search_pool: searchPool()
            });
            startDraft();
        } catch {
            toast.error("Failed to save navigator setup");
        } finally {
            setIsStarting(false);
        }
    };

    return (
        <div class="flex-1 overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto flex min-h-full w-full max-w-[1200px] flex-col p-6 sm:p-8">
                <div class="rounded-xl border border-slate-700/50 bg-slate-800/95 shadow-[0_20px_60px_rgba(15,23,42,0.35)]">
                    <div class="flex flex-col gap-8 p-6 sm:p-8">
                        <section class="flex flex-col gap-5">
                            <div>
                                <h1 class="text-2xl font-bold text-slate-100">
                                    Session Config
                                </h1>
                                <p class="mt-1 text-sm text-slate-400">
                                    Configure the series before the draft room opens.
                                </p>
                            </div>

                            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                                <label class="block">
                                    <span class="mb-2 block text-sm font-medium text-slate-300">
                                        Session Name
                                    </span>
                                    <input
                                        type="text"
                                        value={name()}
                                        onInput={(e) =>
                                            setName(e.currentTarget.value)
                                        }
                                        placeholder="Session name (optional)"
                                        class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-blue-400"
                                    />
                                </label>

                                <div class="flex flex-col gap-2">
                                    <span class="text-sm font-medium text-slate-300">
                                        Our Side
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
                            </div>

                            <label class="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-4 transition-colors hover:border-blue-400/40">
                                <div class="min-w-0">
                                    <div class="text-sm font-medium text-slate-100">
                                        Fearless Mode
                                    </div>
                                    <p class="mt-1 text-xs text-slate-400">
                                        Champions can only be picked once per series.
                                    </p>
                                </div>
                                <div class="relative mt-0.5 shrink-0">
                                    <input
                                        type="checkbox"
                                        checked={fearless()}
                                        onChange={(e) =>
                                            setFearless(e.currentTarget.checked)
                                        }
                                        class="peer sr-only"
                                    />
                                    <span class="block h-6 w-11 rounded-full bg-slate-700 transition-colors peer-checked:bg-blue-500" />
                                    <span class="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                                </div>
                            </label>
                        </section>

                        <section class="flex flex-col gap-4 border-t border-slate-700/60 pt-8">
                            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <div class="flex items-center gap-3">
                                        <h2 class="text-xl font-semibold text-slate-100">
                                            Display Pool
                                        </h2>
                                        <span class="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300">
                                            {displayPool().length} / {champions.length}
                                        </span>
                                    </div>
                                    <p class="mt-1 text-sm text-slate-400">
                                        Champions shown in the draft input panel for quick
                                        selection.
                                    </p>
                                </div>
                            </div>

                            <div class="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
                                <ChampionToggleGrid
                                    selectedChampions={displayPool}
                                    onToggle={toggleChampion}
                                />
                            </div>
                        </section>

                        <section class="flex flex-col gap-4 border-t border-slate-700/60 pt-8">
                            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <div class="flex items-center gap-3">
                                        <h2 class="text-xl font-semibold text-slate-100">
                                            Search Pool
                                        </h2>
                                        <span class="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300">
                                            {searchPool().length} / {champions.length}
                                        </span>
                                    </div>
                                    <p class="mt-1 text-sm text-slate-400">
                                        Broader set the engine considers. Auto-populated
                                        from meta data.
                                    </p>
                                </div>
                            </div>

                            <div class="rounded-lg border border-dashed border-slate-600 bg-slate-900/40 p-4 text-sm text-slate-300">
                                <p>Auto-populated from meta champions + your display pool.</p>
                                <p class="mt-2 text-slate-400">
                                    Search pool = display pool union meta-viable champions.
                                </p>
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
                                    {isStarting() ? "Saving..." : "Start Draft"}
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
