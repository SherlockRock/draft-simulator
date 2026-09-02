import {
    Accessor,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount,
    untrack
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Undo2, X } from "lucide-solid";
import { SearchableSelect } from "./SearchableSelect";
import { SearchResultRow } from "./SearchResultRow";
import { championById, champions } from "../utils/constants";
import type { ScopeHint, SearchBucket, SearchResults } from "../utils/canvasSearch";
import { SCOPE_VALUES, type SearchScope } from "../utils/gameClassification";
import type { SearchRowModel } from "../utils/searchRowModel";
import {
    SEARCH_PANEL_MIN_WIDTH,
    clampPanelGeometry,
    loadPanelGeometry,
    savePanelGeometry,
    type PanelGeometry
} from "../utils/searchPanelGeometry";

const BUCKET_ORDER: SearchBucket[] = [
    "pickedBy",
    "pickedAgainst",
    "bannedBy",
    "bannedAgainst"
];

const BUCKET_LABELS: Record<SearchBucket, string> = {
    pickedBy: "Picked by",
    pickedAgainst: "Picked vs",
    bannedBy: "Banned by",
    bannedAgainst: "Banned vs"
};

const PICK_BUCKETS: SearchBucket[] = ["pickedBy", "pickedAgainst"];

const SCOPE_LABELS: Record<SearchScope, string> = {
    all: "All",
    official: "Official",
    scrim: "Scrims",
    scratch: "Scratch"
};

type CanvasSearchPanelProps = {
    championId: Accessor<string | null>;
    onChampionChange: (championId: string | null) => void;
    teamName: Accessor<string | null>;
    onTeamChange: (teamName: string | null) => void;
    opponentTeamName: Accessor<string | null>;
    onOpponentChange: (teamName: string | null) => void;
    teamOptions: Accessor<string[]>;
    opponentOptions: Accessor<string[]>;
    activeBucket: Accessor<SearchBucket | null>;
    onBucketChange: (bucket: SearchBucket | null) => void;
    scope: Accessor<SearchScope>;
    onScopeChange: (scope: SearchScope) => void;
    results: Accessor<SearchResults | null>;
    pinnedRows: Accessor<SearchRowModel[]>;
    resultRows: Accessor<SearchRowModel[]>;
    scopeHints: Accessor<ScopeHint[]>;
    selectedDraftId: Accessor<string | null>;
    onJumpToDraft: (draftId: string) => void;
    onTogglePin: (draftId: string) => void;
    canReturn: Accessor<boolean>;
    onReturn: () => void;
    onClose: () => void;
    focusNonce: Accessor<number>;
};

type ResizeEdges = { left?: boolean; right?: boolean; bottom?: boolean };

export const CanvasSearchPanel = (props: CanvasSearchPanelProps) => {
    let rootRef: HTMLDivElement | undefined;
    let listRef: HTMLDivElement | undefined;
    const championNames = champions.map((champion) => champion.name);

    // The container is NOT the window (the canvas div sits under page chrome), so
    // the pre-mount value is only an estimate. The panel stays `invisible` for
    // that first frame and is revealed after the mount clamp against the real
    // parent — otherwise a geometry saved near the right/bottom edge paints
    // outside the container for a frame, then visibly snaps. Clamp results are
    // deliberately NOT saved: a transiently small window must not overwrite the
    // user's chosen geometry (only drag/resize end persists).
    const [geometry, setGeometry] = createSignal<PanelGeometry>(
        loadPanelGeometry(window.innerWidth, window.innerHeight)
    );
    const [placed, setPlaced] = createSignal(false);

    const containerRect = (): DOMRect | null =>
        rootRef?.parentElement?.getBoundingClientRect() ?? null;

    onMount(() => {
        const rect = containerRect();
        if (rect) setGeometry((g) => clampPanelGeometry(g, rect.width, rect.height));
        // Deferred one microtask: in the mount flush the focus effect runs
        // before the root's classList render effect, so a synchronous flip
        // would let it call .focus() while the root is still
        // visibility:hidden — a silent no-op. After the microtask the flip
        // is its own update cycle, where the reveal renders first and the
        // focus effect re-runs against a focusable input.
        queueMicrotask(() => setPlaced(true));
        const onWindowResize = () => {
            const r = containerRect();
            if (r) setGeometry((g) => clampPanelGeometry(g, r.width, r.height));
        };
        window.addEventListener("resize", onWindowResize);
        onCleanup(() => window.removeEventListener("resize", onWindowResize));
    });

    // A gesture's document listeners MUST NOT outlive the panel: Esc, route
    // navigation, or a canvas switch can unmount it mid-drag, and orphaned
    // handlers would keep mutating disposed state and persist a junk geometry
    // on the eventual mouseup. One active gesture at a time; onCleanup tears
    // down whichever is live.
    let stopActiveGesture: (() => void) | null = null;

    const beginGesture = (onMove: (ev: MouseEvent) => void, onSettle: () => void) => {
        const stop = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            stopActiveGesture = null;
        };
        const onUp = () => {
            stop();
            onSettle();
        };
        stopActiveGesture?.();
        stopActiveGesture = stop;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };

    onCleanup(() => stopActiveGesture?.());

    const startDrag = (e: MouseEvent) => {
        if (e.button !== 0) return;
        if (e.target instanceof Element && e.target.closest("button, input")) return;
        e.preventDefault();
        const start = geometry();
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = containerRect();
        beginGesture(
            (ev) => {
                const next = {
                    ...start,
                    x: start.x + (ev.clientX - startX),
                    y: start.y + (ev.clientY - startY)
                };
                setGeometry(
                    rect ? clampPanelGeometry(next, rect.width, rect.height) : next
                );
            },
            () => savePanelGeometry(geometry())
        );
    };

    const startResize = (e: MouseEvent, edges: ResizeEdges) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const start = geometry();
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = containerRect();
        beginGesture(
            (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let { x, width, height } = start;
                if (edges.right) width = start.width + dx;
                if (edges.bottom) height = start.height + dy;
                if (edges.left) {
                    width = Math.max(SEARCH_PANEL_MIN_WIDTH, start.width - dx);
                    x = start.x + (start.width - width);
                }
                const next = { x, y: start.y, width, height };
                setGeometry(
                    rect ? clampPanelGeometry(next, rect.width, rect.height) : next
                );
            },
            () => savePanelGeometry(geometry())
        );
    };

    const initialChampionName = () => {
        const id = props.championId();
        if (id === null) return "";
        return champions.find((champion) => champion.id === id)?.name ?? "";
    };
    const [championText, setChampionText] = createSignal(initialChampionName());
    const [teamText, setTeamText] = createSignal(untrack(() => props.teamName() ?? ""));
    const [opponentText, setOpponentText] = createSignal(
        untrack(() => props.opponentTeamName() ?? "")
    );
    // A team change can clear the opponent from OUTSIDE this field (Canvas enforces
    // opponent ⇒ team, opponent ≠ team); resync the text only on that path so
    // typing is never clobbered mid-edit (blur/commit ordering gotcha).
    createEffect(() => {
        props.teamName();
        setOpponentText(untrack(() => props.opponentTeamName()) ?? "");
    });
    const handleOpponentText = (value: string) => {
        setOpponentText(value);
        if (value.trim() === "") props.onOpponentChange(null);
    };

    createEffect(() => {
        props.focusNonce();
        if (!placed()) return;
        const input = rootRef?.querySelector("input");
        input?.focus();
        input?.select();
    });

    const matchCount = createMemo(() => props.results()?.matches.length ?? null);

    const emptyStateChampionName = createMemo(() => {
        const id = props.championId();
        if (id === null || id === "") return null;
        return championById.get(id)?.name ?? id;
    });

    const handleChampionText = (value: string) => {
        setChampionText(value);
        if (value.trim() === "") props.onChampionChange(null);
    };

    const handleChampionSelect = (name: string) => {
        const champion = champions.find((entry) => entry.name === name);
        props.onChampionChange(champion ? champion.id : null);
    };

    const handleTeamText = (value: string) => {
        setTeamText(value);
        if (value.trim() === "") props.onTeamChange(null);
    };

    const handleKeyDownCapture = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
        }
    };

    createEffect(() => {
        const root = rootRef;
        if (!root) return;
        root.addEventListener("keydown", handleKeyDownCapture, { capture: true });
        onCleanup(() => {
            root.removeEventListener("keydown", handleKeyDownCapture, {
                capture: true
            });
        });
    });

    const handleRootKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Enter" || e.defaultPrevented) return;
        if (e.target instanceof HTMLButtonElement) return;
        const first =
            rowsState.pinned[0]?.draftId ?? rowsState.results[0]?.draftId ?? null;
        const target = props.selectedDraftId() ?? first;
        if (target === null) return;
        e.preventDefault();
        e.stopPropagation();
        props.onJumpToDraft(target);
    };

    const [rowsState, setRowsState] = createStore<{
        pinned: SearchRowModel[];
        results: SearchRowModel[];
    }>({ pinned: [], results: [] });
    createEffect(() =>
        setRowsState("pinned", reconcile(props.pinnedRows(), { key: "draftId" }))
    );
    createEffect(() =>
        setRowsState("results", reconcile(props.resultRows(), { key: "draftId" }))
    );

    // Keep the selected row visible when selection moves via keyboard.
    createEffect(() => {
        const selected = props.selectedDraftId();
        if (selected === null || !listRef) return;
        listRef
            .querySelector(`[data-row-draft-id="${CSS.escape(selected)}"]`)
            ?.scrollIntoView({ block: "nearest" });
    });

    return (
        <div
            ref={rootRef}
            data-canvas-search-panel="true"
            class="absolute z-50 flex select-text flex-col overflow-hidden rounded-xl border border-darius-border bg-darius-card/95 shadow-[0_16px_40px_rgba(15,23,42,0.6)] backdrop-blur-sm"
            classList={{ invisible: !placed() }}
            style={{
                left: `${geometry().x}px`,
                top: `${geometry().y}px`,
                width: `${geometry().width}px`,
                height: `${geometry().height}px`
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onKeyDown={handleRootKeyDown}
        >
            <div
                class="flex cursor-move items-center gap-2 border-b border-darius-border px-3 py-2"
                onMouseDown={startDrag}
            >
                <span class="text-sm font-semibold text-darius-text-primary">Search</span>
                <Show when={matchCount() !== null}>
                    <span class="text-xs tabular-nums text-darius-text-secondary">
                        {matchCount()} {matchCount() === 1 ? "game" : "games"}
                    </span>
                </Show>
                <Show when={props.canReturn()}>
                    <button
                        type="button"
                        onClick={() => props.onReturn()}
                        class="flex items-center gap-1 rounded-full border border-darius-border px-2 py-0.5 text-xs text-darius-text-secondary transition-colors hover:border-darius-purple-bright/60 hover:text-darius-text-primary"
                    >
                        <Undo2 size={12} /> Return
                    </button>
                </Show>
                <button
                    type="button"
                    onClick={() => props.onClose()}
                    class="ml-auto flex size-7 items-center justify-center rounded-lg text-darius-text-secondary transition-colors hover:text-darius-crimson"
                    aria-label="Close search"
                >
                    <X size={16} />
                </button>
            </div>

            <div class="flex flex-col gap-2 px-3 pt-2">
                <div class="flex flex-wrap items-center gap-2">
                    <div class="w-52">
                        <SearchableSelect
                            placeholder="Champion…"
                            currentlySelected={initialChampionName()}
                            sortOptions={championNames}
                            selectText={championText()}
                            setSelectText={handleChampionText}
                            onValidSelect={handleChampionSelect}
                            theme="purple"
                            textInput={true}
                        />
                    </div>
                    <div class="w-44">
                        <SearchableSelect
                            placeholder="Team (optional)"
                            currentlySelected={props.teamName() ?? ""}
                            sortOptions={props.teamOptions()}
                            selectText={teamText()}
                            setSelectText={handleTeamText}
                            onValidSelect={(name) => props.onTeamChange(name)}
                            theme="purple"
                            textInput={true}
                        />
                    </div>
                    <div class="w-44">
                        <SearchableSelect
                            placeholder="Opponent…"
                            currentlySelected={props.opponentTeamName() ?? ""}
                            sortOptions={props.opponentOptions()}
                            selectText={opponentText()}
                            setSelectText={handleOpponentText}
                            onValidSelect={(name) => props.onOpponentChange(name)}
                            theme="purple"
                            textInput={true}
                            disabled={props.teamName() === null}
                            title={
                                props.teamName() === null
                                    ? "Pick a team first"
                                    : undefined
                            }
                        />
                    </div>
                </div>

                {/*
                  Always visible, and it now filters every query rather than only
                  team-filtered ones — a chip row that visibly did nothing without a
                  team read as broken. "All" still means no filter when there is no
                  team, so champion search keeps spanning loose cards and unclassified
                  groups.
                */}
                <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-xs text-darius-text-secondary">Show</span>
                    <For each={SCOPE_VALUES}>
                        {(scope) => (
                            <button
                                type="button"
                                onClick={() => props.onScopeChange(scope)}
                                class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                                classList={{
                                    "border-darius-purple-bright bg-darius-purple/25 text-darius-text-primary":
                                        props.scope() === scope,
                                    "border-darius-border bg-darius-card text-darius-text-secondary hover:border-darius-purple-bright/60":
                                        props.scope() !== scope
                                }}
                            >
                                {SCOPE_LABELS[scope]}
                            </button>
                        )}
                    </For>
                </div>

                <Show when={props.results()?.teamRecord}>
                    {(record) => (
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-darius-text-secondary">
                            <span class="font-semibold text-darius-text-primary">
                                {record().games} {record().games === 1 ? "game" : "games"}
                            </span>
                            <span aria-hidden="true" class="opacity-40">
                                ·
                            </span>
                            <span>
                                <span class="font-semibold text-darius-text-primary">
                                    {record().wins}W-{record().losses}L
                                </span>
                            </span>
                            <Show when={record().noResult > 0}>
                                <span aria-hidden="true" class="opacity-40">
                                    ·
                                </span>
                                <span class="opacity-70">
                                    {record().noResult} no result
                                </span>
                            </Show>
                            <Show when={record().inProgress > 0}>
                                <span aria-hidden="true" class="opacity-40">
                                    ·
                                </span>
                                <span class="text-darius-ember">
                                    {record().inProgress} in progress
                                </span>
                            </Show>
                        </div>
                    )}
                </Show>

                <Show when={props.results()?.buckets}>
                    {(buckets) => (
                        <div class="flex flex-wrap items-center gap-1.5">
                            <For each={BUCKET_ORDER}>
                                {(bucket) => (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            props.onBucketChange(
                                                props.activeBucket() === bucket
                                                    ? null
                                                    : bucket
                                            )
                                        }
                                        class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                                        classList={{
                                            "border-darius-purple-bright bg-darius-purple/25 text-darius-text-primary":
                                                props.activeBucket() === bucket,
                                            "border-darius-border bg-darius-card text-darius-text-secondary hover:border-darius-purple-bright/60":
                                                props.activeBucket() !== bucket
                                        }}
                                    >
                                        {BUCKET_LABELS[bucket]}{" "}
                                        <span class="font-semibold">
                                            {buckets()[bucket].games}
                                        </span>
                                        <Show when={PICK_BUCKETS.includes(bucket)}>
                                            <span class="ml-1 opacity-80">
                                                {buckets()[bucket].wins}W-
                                                {buckets()[bucket].losses}L
                                            </span>
                                        </Show>
                                        <Show when={buckets()[bucket].noResult > 0}>
                                            <span class="ml-1 opacity-60">
                                                {buckets()[bucket].noResult} no result
                                            </span>
                                        </Show>
                                        <Show when={buckets()[bucket].inProgress > 0}>
                                            <span class="ml-1 text-darius-ember">
                                                {buckets()[bucket].inProgress} in progress
                                            </span>
                                        </Show>
                                    </button>
                                )}
                            </For>
                        </div>
                    )}
                </Show>
            </div>

            <div
                ref={listRef}
                class="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3"
            >
                <Show when={rowsState.pinned.length > 0}>
                    <div class="pt-2 text-xs font-semibold uppercase tracking-wide text-darius-text-secondary">
                        Pinned
                    </div>
                    <For each={rowsState.pinned}>
                        {(row) => (
                            <SearchResultRow
                                row={row}
                                selected={props.selectedDraftId() === row.draftId}
                                pinned={true}
                                onJump={props.onJumpToDraft}
                                onTogglePin={props.onTogglePin}
                            />
                        )}
                    </For>
                    <div class="mt-2 border-b border-darius-border" />
                </Show>
                <For each={rowsState.results}>
                    {(row) => (
                        <SearchResultRow
                            row={row}
                            selected={props.selectedDraftId() === row.draftId}
                            pinned={false}
                            onJump={props.onJumpToDraft}
                            onTogglePin={props.onTogglePin}
                        />
                    )}
                </For>
                <Show when={props.results() === null}>
                    <div class="py-8 text-center text-sm text-darius-text-secondary">
                        Search by champion or team.
                    </div>
                </Show>
                <Show when={matchCount() === 0}>
                    <Show
                        when={props.opponentTeamName() !== null}
                        fallback={
                            <div class="py-8 text-center text-sm text-darius-text-secondary">
                                No matches on this canvas.
                            </div>
                        }
                    >
                        <div class="py-8 text-center text-sm text-darius-text-secondary">
                            <Show
                                when={emptyStateChampionName()}
                                fallback={
                                    <>
                                        <span class="font-semibold text-darius-text-primary">
                                            {props.teamName()}
                                        </span>
                                        {" and "}
                                        <span class="font-semibold text-darius-text-primary">
                                            {props.opponentTeamName()}
                                        </span>
                                        {" have no games on this canvas."}
                                    </>
                                }
                            >
                                {(name) => (
                                    <>
                                        {"No "}
                                        <span class="font-semibold text-darius-text-primary">
                                            {name()}
                                        </span>
                                        {" games between "}
                                        <span class="font-semibold text-darius-text-primary">
                                            {props.teamName()}
                                        </span>
                                        {" and "}
                                        <span class="font-semibold text-darius-text-primary">
                                            {props.opponentTeamName()}
                                        </span>
                                        {" on this canvas."}
                                    </>
                                )}
                            </Show>
                            <For each={props.scopeHints()}>
                                {(hint) => (
                                    <div class="mt-1">
                                        {hint.games}{" "}
                                        {hint.games === 1 ? "game exists" : "games exist"}{" "}
                                        under {SCOPE_LABELS[hint.scope]}
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </Show>
            </div>

            <div
                class="absolute bottom-3 left-0 top-12 w-1 cursor-ew-resize"
                onMouseDown={(e) => startResize(e, { left: true })}
            />
            <div
                class="absolute bottom-3 right-0 top-12 w-1 cursor-ew-resize"
                onMouseDown={(e) => startResize(e, { right: true })}
            />
            <div
                class="absolute inset-x-3 bottom-0 h-1.5 cursor-ns-resize"
                onMouseDown={(e) => startResize(e, { bottom: true })}
            />
            <div
                class="absolute bottom-0 right-0 size-3 cursor-nwse-resize"
                onMouseDown={(e) => startResize(e, { right: true, bottom: true })}
            />
            <div
                class="absolute bottom-0 left-0 size-3 cursor-nesw-resize"
                onMouseDown={(e) => startResize(e, { left: true, bottom: true })}
            />
        </div>
    );
};
