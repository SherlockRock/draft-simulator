import {
    Component,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup,
    onMount
} from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import toast from "solid-toast";
import ChampionPicker, { type ChampionColorState } from "../ChampionPicker";
import { ContextMenu } from "../ContextMenu";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import type {
    NavigatorEventData,
    NavigatorTreeNode
} from "../../contexts/NavigatorContext";
import { fetchCanvasList, postNewDraft } from "../../utils/actions";
import { ApiError } from "../../utils/apiClient";
import { resolveChampion } from "../../utils/constants";
import {
    clampSelectedPath,
    deriveColumns,
    describeLine,
    fanoutDepth,
    fanoutParent,
    lineNodes,
    remapSelectedPath,
    sidePicksBefore,
    topLinePath,
    type ColumnModel
} from "../../utils/navigatorColumns";
import { deriveEngineStatus, type EngineProgress } from "../../utils/navigatorEngineStatus";
import {
    EXPORT_CANVAS_STORAGE_KEY,
    exportDraftDescription,
    exportDraftName,
    lineToCanvasPicks
} from "../../utils/navigatorExport";
import {
    buildPaletteCommands,
    type PaletteCommandId
} from "../../utils/navigatorPalette";
import {
    detectStaleBuckets,
    getPickerState,
    rebucketDisplay,
    staleBucketSummary
} from "../../utils/navigatorPool";
import {
    ROLE_SHORT_LABELS,
    emptyFanReason,
    formatRoleGap,
    roleGap,
    roleLineForPick
} from "../../utils/navigatorRoles";
import { ROLES } from "../../utils/championRoles";
import type { RolePoolMap, TeamPool } from "@draft-sim/shared-types";
import { getOurSideForGame } from "../../utils/navigatorSide";
import { eventsToConfirmedTurns } from "../../utils/treeReconcile";
import {
    PHASE_LABELS,
    TURN_SEQUENCE,
    turnLabel,
    turnLabelForSlots
} from "../../utils/turnSequence";
import type { ContextMenuAction } from "../../utils/types";
import { BetweenGamesPanel } from "./BetweenGamesPanel";
import { EngineStatusPill } from "./EngineStatusPill";
import { NavigatorColumns, type NodeRoleLine } from "./NavigatorColumns";
import { NavigatorCommandPalette, type PaletteTurn } from "./NavigatorCommandPalette";
import { NavigatorTimeline } from "./NavigatorTimeline";
import { PoolEditModal } from "./PoolEditModal";
import { SeriesTabStrip } from "./SeriesTabStrip";

type ContentAddressedStep = { slot: number; championIds: string[] };
const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;

function readStoredCanvasId(): string | null {
    try {
        return localStorage.getItem(EXPORT_CANVAS_STORAGE_KEY);
    } catch {
        return null;
    }
}
function storeCanvasId(id: string): void {
    try {
        localStorage.setItem(EXPORT_CANVAS_STORAGE_KEY, id);
    } catch {
        /* storage unavailable — the choice just is not remembered */
    }
}

const NavigatorDrafting: Component = () => {
    const {
        navigatorContext,
        syntheticTree,
        isComputing,
        computeFailed,
        currentMeta,
        engineHeartbeat,
        emitPickStep,
        emitBan,
        emitUndo,
        swapChampion,
        createBranch,
        viewingGameNumber,
        viewGame,
        startNextGame,
        updateSessionPools
    } = useNavigatorContext();

    // ---- session / draft / archive (unchanged semantics from the old file) ----
    const session = () => navigatorContext().session;
    const activeDraft = () => navigatorContext().draft;
    const completedGames = () => navigatorContext().completedGames;
    const viewingArchive = createMemo(() => {
        const gn = viewingGameNumber();
        if (gn === null) return null;
        return completedGames().find((c) => c.draft.game_number === gn) ?? null;
    });
    const showBetweenGamesPanel = createMemo(
        () => viewingGameNumber() === null && activeDraft()?.status === "completed"
    );
    const isSeriesComplete = createMemo(() => {
        const s = session();
        const d = activeDraft();
        return !!s && !!d && d.status === "completed" && d.game_number >= s.series_length;
    });
    const crossGameExcluded = createMemo(() => {
        const map = new Map<string, number>();
        const s = session();
        if (!s || s.draft_mode === "standard") return map;
        const includeBans = s.draft_mode === "ironman";
        for (const archive of completedGames()) {
            for (const event of archive.events) {
                if (
                    event.event_type === "pick" ||
                    (includeBans && event.event_type === "ban")
                ) {
                    if (!map.has(event.champion_id))
                        map.set(event.champion_id, archive.draft.game_number);
                }
            }
        }
        return map;
    });

    // ---- derived draft state ----
    const confirmedEvents = createMemo<NavigatorEventData[]>(() => {
        const archive = viewingArchive();
        const source = archive ? archive.events : navigatorContext().events;
        return source
            .filter((e) => e.event_type === "ban" || e.event_type === "pick")
            .sort((a, b) => a.slot - b.slot);
    });
    const turns = createMemo(() => eventsToConfirmedTurns(confirmedEvents()));
    const ourSide = createMemo<"blue" | "red">(() => {
        const s = session();
        const d = viewingArchive()?.draft ?? activeDraft();
        return s && d ? getOurSideForGame(s, d) : "blue";
    });
    // Archive mode renders no columns (see the archive card below); the tree is the live one only.
    const tree = createMemo<NavigatorTreeNode | null>(() =>
        viewingArchive() ? null : syntheticTree()
    );
    const fanout = createMemo(() => {
        const t = tree();
        return t ? fanoutParent(t, turns()) : null;
    });
    const fan = createMemo(() => fanout()?.children ?? []);
    const computing = createMemo(() => (viewingArchive() ? false : isComputing()));
    const canMutate = createMemo(
        () => viewingArchive() === null && activeDraft()?.status === "active"
    );
    const draftComplete = createMemo(
        () =>
            confirmedEvents().length >= TURN_SEQUENCE.length ||
            activeDraft()?.status === "completed"
    );
    const nextSlot = createMemo<number | null>(() =>
        draftComplete() ? null : confirmedEvents().length
    );
    const nextTurn = createMemo(() => {
        const slot = nextSlot();
        return slot === null ? null : (TURN_SEQUENCE[slot] ?? null);
    });
    const picksOf = (side: "blue" | "red") =>
        turns()
            .filter((t) => t.actionType === "pick" && t.side === side)
            .flatMap((t) => t.championIds);
    const gapText = createMemo(() => ({
        blue: formatRoleGap(roleGap(picksOf("blue")), picksOf("blue").length),
        red: formatRoleGap(roleGap(picksOf("red")), picksOf("red").length)
    }));
    const usedChampionIdSet = createMemo(
        () => new Set(confirmedEvents().map((e) => e.champion_id))
    );
    const unavailable = createMemo(
        () => new Set([...usedChampionIdSet(), ...crossGameExcluded().keys()])
    );
    // The old picker column's tooltip: "{Name} — picked in Game N (fearless|ironman)".
    const unavailableReason = (championId: string): string | null => {
        const game = crossGameExcluded().get(championId);
        if (game === undefined)
            return usedChampionIdSet().has(championId) ? "already used this game" : null;
        return `picked in Game ${game} (${session()?.draft_mode ?? "fearless"})`;
    };
    const canEditPools = createMemo(() =>
        canMutate()
            ? confirmedEvents().length === 0
            : activeDraft()?.status === "completed" && viewingArchive() === null
    );
    const stale = createMemo(() => {
        const s = session();
        return (
            !!s &&
            detectStaleBuckets(s.blue_pool).length +
                detectStaleBuckets(s.red_pool).length >
                0
        );
    });

    // ---- thinking clock (design § 4: elapsed on the client clock) ----
    // Anchored on the transition INTO computing, not on the event count: a
    // reconnect with an unchanged count and a stale snapshot would otherwise read
    // minutes. Swap/branch recomputes now DO enter `isComputing` via the
    // heartbeat clause.
    const [thinkingSince, setThinkingSince] = createSignal(Date.now());
    const [elapsedMs, setElapsedMs] = createSignal(0);
    createEffect(
        on(computing, (now, prev) => {
            if (now && prev !== true) setThinkingSince(Date.now());
        })
    );
    const [heartbeatStaleMs, setHeartbeatStaleMs] = createSignal<number | null>(null);
    createEffect(() => {
        if (!computing()) {
            setElapsedMs(0);
            setHeartbeatStaleMs(null);
            return;
        }
        const tick = () => {
            setElapsedMs(Date.now() - thinkingSince());
            const hb = engineHeartbeat();
            setHeartbeatStaleMs(hb ? Date.now() - hb.receivedAt : null);
        };
        tick();
        const timer = setInterval(tick, 100);
        onCleanup(() => clearInterval(timer));
    });
    // Heartbeat first (live), else the painted partial's own meta.
    const progress = createMemo<EngineProgress | null>(() => {
        const hb = engineHeartbeat();
        if (hb) return { depthPainted: hb.depthPainted, depthInProgress: hb.depthInProgress, nodes: hb.nodes };
        const m = currentMeta();
        if (m && m.inProgress === true)
            return { depthPainted: m.depthReached, depthInProgress: m.depthInProgress ?? 0, nodes: m.nodesEvaluated };
        return null;
    });
    const status = createMemo(() =>
        deriveEngineStatus({
            hasSnapshot:
                (viewingArchive()?.snapshot ?? navigatorContext().snapshot) !== null,
            eventCount: confirmedEvents().length,
            draftComplete: draftComplete(),
            isComputing: computing(),
            fanCount: fan().length,
            meta: currentMeta(),
            elapsedMs: elapsedMs(),
            reason: () => emptyFanReason(picksOf("blue"), picksOf("red"), nameOf),
            progress: progress(),
            budgetHit: currentMeta()?.budgetHit === true,
            heartbeatStaleMs: heartbeatStaleMs(),
            computeFailed: viewingArchive() ? false : computeFailed()
        })
    );

    // ---- columns + selection (design § 2) ----
    const [selectedPath, setSelectedPath] = createSignal<number[]>([]);
    // Reset when the SCOPE changes: a commit (count), a game switch or an archive
    // switch (equal counts are common: 20 → 20). Phase 1 writes tree + events in
    // one batch, so this fires exactly once per commit and never on Phase 2.
    const selectionScope = createMemo(
        () =>
            `${viewingGameNumber() ?? "live"}|${viewingArchive()?.draft.id ?? activeDraft()?.id ?? ""}|${confirmedEvents().length}`
    );
    createEffect(on(selectionScope, () => setSelectedPath([]), { defer: true }));
    // Phase 2 re-ranks the fan with the count unchanged: follow the champion, not the index.
    // NOT deferred (execution ruling 2026-09-07): Solid's `on` skips `prevInput = input`
    // on a deferred first run, so the FIRST fanout change after mount would see
    // `prevF === undefined` and clamp by index. At mount the path is `[]`, so the
    // extra run is a no-op through either branch.
    createEffect(
        on(fanout, (f, prevF) => {
            if (!f) return;
            setSelectedPath((p) =>
                prevF ? remapSelectedPath(prevF, f, p) : clampSelectedPath(f, p)
            );
        })
    );
    const columns = createMemo<ColumnModel[]>(() => {
        const f = fanout();
        return f ? deriveColumns(f, selectedPath()) : [];
    });
    const selectedNodes = createMemo(() => {
        const f = fanout();
        return f ? lineNodes(f, selectedPath()) : [];
    });
    const roleLineFor = (node: NavigatorTreeNode, column: ColumnModel): NodeRoleLine => {
        if (node.actionType === "ban" || node.side === null)
            return { roles: [], shift: null };
        const before = sidePicksBefore(turns(), column.lineage, node.side);
        const line = roleLineForPick(
            before,
            node.championIds,
            node.assignmentDistribution,
            node.confirmedChampionIds ?? []
        );
        return {
            roles: line.roles.map((r) => (r ? ROLE_SHORT_LABELS[r] : "?")),
            shift: line.shift
                ? `${nameOf(line.shift.championId)} → ${ROLE_SHORT_LABELS[line.shift.to]}`
                : null
        };
    };
    const rankedRoleLine = (championId: string): string => {
        const node = fan().find((n) => n.championIds.includes(championId));
        if (!node) return "";
        const line = roleLineFor(node, {
            depth: 0,
            nodes: fan(),
            selectedIndex: null,
            lineage: []
        });
        return [line.roles.join(" · "), line.shift].filter((s) => s).join(" · ");
    };

    // ---- commits (slot = confirmed event count, as the old picker column did) ----
    const commitChampions = (championIds: string[]) => {
        const draftId = activeDraft()?.id;
        const slot = nextSlot();
        const turn = nextTurn();
        if (!draftId || slot === null || !turn || championIds.length === 0) return;
        if (turn.type === "pick") emitPickStep(draftId, championIds, slot);
        else emitBan(draftId, championIds[0], slot);
        closePalette();
    };
    const commitNode = (node: NavigatorTreeNode) => {
        const confirmed = new Set(node.confirmedChampionIds ?? []);
        commitChampions(node.championIds.filter((id) => !confirmed.has(id)));
    };
    const undo = () => {
        const draftId = activeDraft()?.id;
        if (draftId) emitUndo(draftId);
    };

    // ---- modal state (declared first: the palette guard reads it) ----
    const [poolEditOpen, setPoolEditOpen] = createSignal(false);
    const [swapTarget, setSwapTarget] = createSignal<{
        path: ContentAddressedStep[];
        targetSlot: number;
        oldChampionId: string;
        contextLabel: string;
        side: "blue" | "red" | null;
    } | null>(null);
    const [branchTarget, setBranchTarget] = createSignal<{
        path: ContentAddressedStep[];
        targetSlot: number;
        contextLabel: string;
        side: "blue" | "red" | null;
    } | null>(null);

    // ---- palette (design § 6) ----
    const [palette, setPalette] = createSignal<{
        anchor: { left: number; top: number } | null;
    } | null>(null);
    let pageEl: HTMLDivElement | undefined;
    // Two meanings, kept apart: the timeline's next slot exists whenever the turn
    // is open; the palette may additionally not open while a modal (swap/branch
    // picker, pool editor) is up — both are z-50 window-keydown consumers and
    // the palette would open behind them.
    const turnIsOpen = () => canMutate() && !draftComplete();
    const canOpenPalette = () =>
        turnIsOpen() &&
        swapTarget() === null &&
        branchTarget() === null &&
        !poolEditOpen();
    const PALETTE_WIDTH = 720;
    const openPalette = (anchorEl: HTMLElement | null) => {
        if (!canOpenPalette()) return;
        if (anchorEl && pageEl) {
            const r = anchorEl.getBoundingClientRect();
            const p = pageEl.getBoundingClientRect();
            const left = Math.max(
                8,
                Math.min(r.left - p.left - 8, p.width - PALETTE_WIDTH - 16)
            );
            setPalette({ anchor: { left, top: r.bottom - p.top + 10 } });
        } else {
            setPalette({ anchor: null });
        }
    };
    const closePalette = () => {
        setPalette(null);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    const onSlashKey = (e: KeyboardEvent) => {
        const t = e.target;
        if (
            t instanceof HTMLInputElement ||
            t instanceof HTMLTextAreaElement ||
            (t instanceof HTMLElement && t.isContentEditable)
        )
            return;
        if (e.key === "/" && palette() === null && canOpenPalette()) {
            e.preventDefault();
            openPalette(null);
        }
    };
    onMount(() => {
        window.addEventListener("keydown", onSlashKey);
        onCleanup(() => window.removeEventListener("keydown", onSlashKey));
    });
    const paletteTurn = createMemo<PaletteTurn | null>(() => {
        const slot = nextSlot();
        const turn = nextTurn();
        if (slot === null || !turn) return null;
        const last = turns()[turns().length - 1];
        const partnerOf =
            last?.pairState === "pair-pending" ? (last.championIds[0] ?? null) : null;
        return { slot, type: turn.type, collect: turn.pairStart ? 2 : 1, partnerOf };
    });
    const paletteHeading = createMemo(() => {
        const slot = nextSlot();
        const turn = nextTurn();
        if (slot === null || !turn) return "Draft complete";
        return turn.pairStart ? turnLabelForSlots([slot, slot + 1]) : turnLabel(slot);
    });
    const commands = createMemo(() =>
        buildPaletteCommands({
            turn: paletteTurn()
                ? { slot: paletteTurn()?.slot ?? 0, type: paletteTurn()?.type ?? "pick" }
                : null,
            slotLabel: paletteHeading(),
            isOurTurn: nextTurn()?.side === ourSide(),
            hasFan: fan().length > 0,
            lastEventChampionName: (() => {
                const last = confirmedEvents()[confirmedEvents().length - 1];
                return last ? nameOf(last.champion_id) : null;
            })(),
            hasSelection: selectedPath().length > 0,
            canEditPools: canEditPools(),
            stale: stale()
        })
    );
    const coloring = (championId: string): ChampionColorState => {
        const s = session();
        if (!s) return "neutral";
        return getPickerState(
            championId,
            nextTurn()?.side ?? null,
            s.blue_pool,
            s.red_pool,
            usedChampionIdSet()
        );
    };
    // Re-bucketing is the one irreversible pool write in this PR, so it is never
    // applied blind: the pool editor opens PRE-FILLED with the migration and its
    // Save is the confirmation (the user can un-widen a bucket first).
    // PoolEditModal re-seeds whenever these props CHANGE (its effect tracks them),
    // not only on open — never write `seededPools` while the modal is open.
    const [seededPools, setSeededPools] = createSignal<{
        blue: TeamPool;
        red: TeamPool;
    } | null>(null);
    const openRebucketReview = () => {
        const s = session();
        if (!s) return;
        setSeededPools({
            blue: rebucketDisplay(s.blue_pool),
            red: rebucketDisplay(s.red_pool)
        });
        setPoolEditOpen(true);
    };
    const closePoolEditor = () => {
        // Order matters: close first, then clear the seed — reversed, the modal's
        // re-seed effect would fire once more (still open) with the un-migrated pools.
        setPoolEditOpen(false);
        setSeededPools(null);
    };
    const runCommand = (id: PaletteCommandId) => {
        const f = fanout();
        if (id === "top-line" && f) setSelectedPath(topLinePath(f));
        else if (id === "undo") undo();
        else if (id === "clear") setSelectedPath([]);
        else if (id === "pools") setPoolEditOpen(true);
        else if (id === "rebucket") openRebucketReview();
        closePalette();
    };
    const explore = (championId: string) => {
        const idx = fan().findIndex((n) => n.championIds.includes(championId));
        setSelectedPath(idx >= 0 ? [idx] : []);
        closePalette();
    };
    const bucketCounts = (side: "Blue" | "Red", display: RolePoolMap): string =>
        `${side}: ${ROLES.map((r) => `${ROLE_SHORT_LABELS[r]} ${display[r].length}`).join(" · ")}`;
    const preview = (id: PaletteCommandId): string[] => {
        const f = fanout();
        const s = session();
        const n = confirmedEvents().length;
        if (id === "top-line" && f)
            return describeLine(lineNodes(f, topLinePath(f)), nameOf);
        if (id === "undo")
            return n > 0
                ? [
                      `Removes ${turnLabel(n - 1)}: ${nameOf(confirmedEvents()[n - 1].champion_id)}`
                  ]
                : ["Nothing to undo"];
        if (id === "clear") return ["Collapses every column back to the ranked fan"];
        if (id === "pools" && s)
            return [
                bucketCounts("Blue", s.blue_pool.display),
                bucketCounts("Red", s.red_pool.display)
            ];
        if (id === "rebucket" && s)
            return [
                "Opens the pool editor pre-filled with the migration — review, then Save. Each champion is added to ALL its listed roles (hand-narrowed single-role entries widen too).",
                ...staleBucketSummary(s.blue_pool, nameOf).map((l) => `Blue · ${l}`),
                ...staleBucketSummary(s.red_pool, nameOf).map((l) => `Red · ${l}`)
            ];
        if (id === "export")
            return selectedNodes().length > 0
                ? ["Projected:", ...describeLine(selectedNodes(), nameOf)]
                : ["Select a line first"];
        // Reached only when the command is disabled — when enabled the ranked
        // rows render instead.
        if (id === "explore")
            return ["Choose a candidate to open its line without committing it"];
        if (id === "pick") return ["Choose a champion for this turn"];
        return [];
    };

    // ---- export (design § 8) ----
    const [rememberedCanvasId, setRememberedCanvasId] = createSignal<string | null>(
        readStoredCanvasId()
    );
    // Only the export command needs the list: fetch when the palette is open AND a line is selected.
    const canvasListQuery = useQuery(() => ({
        queryKey: ["canvasList"],
        queryFn: fetchCanvasList,
        enabled: palette() !== null && selectedPath().length > 0,
        staleTime: 60_000
    }));
    const exportLine = async (canvasId: string) => {
        const s = session();
        const d = activeDraft();
        const nodes = selectedNodes();
        if (!s || !d || nodes.length === 0) return;
        const picks = lineToCanvasPicks(confirmedEvents(), nodes);
        const first = nodes[0];
        const confirmedHalf = new Set(first.confirmedChampionIds ?? []);
        const lineChampion = nameOf(
            first.championIds.find((id) => !confirmedHalf.has(id)) ??
                first.championIds[0] ??
                ""
        );
        closePalette();
        try {
            const draft = await postNewDraft({
                name: exportDraftName(d.game_number, ourSide(), lineChampion),
                public: false,
                picks,
                canvas_id: canvasId,
                description: exportDraftDescription({
                    sessionLabel: s.name ?? s.id,
                    gameNumber: d.game_number,
                    confirmedCount: confirmedEvents().length,
                    nodes,
                    nameOf
                })
            });
            storeCanvasId(canvasId);
            setRememberedCanvasId(canvasId);
            const canvasName =
                canvasListQuery.data?.find((c) => c.id === canvasId)?.name ?? "canvas";
            toast.success(() => (
                <span>
                    Exported "{draft.name}" to {canvasName} —{" "}
                    <a class="underline" href={`/canvas/${canvasId}`}>
                        open
                    </a>
                </span>
            ));
        } catch (err) {
            if (err instanceof ApiError && err.status === 403)
                toast.error("You can only export to canvases you can edit");
            else toast.error("Export failed");
        }
    };

    // ---- context menu → swap / branch / copy (kept from the radial tree) ----
    const [menu, setMenu] = createSignal<{
        node: NavigatorTreeNode;
        depth: number;
        index: number;
        x: number;
        y: number;
    } | null>(null);
    const indexPathFor = (depth: number, index: number): number[] => [
        ...new Array<number>(fanoutDepth(turns())).fill(0),
        ...selectedPath().slice(0, depth),
        index
    ];
    // Walks the synthetic tree by index path; returns the PARENT lineage
    // (content-addressed), the target slot and the target's championIds —
    // the EngineRequest.config.forcedBranches[].path shape (unchanged).
    const deriveContentAddressedTarget = (indexPath: number[]) => {
        const t = tree();
        if (!t || indexPath.length === 0) return null;
        const lineage: ContentAddressedStep[] = [];
        let node: NavigatorTreeNode = t;
        for (const idx of indexPath) {
            const next: NavigatorTreeNode | undefined = node.children[idx];
            if (!next) return null;
            node = next;
            lineage.push({ slot: node.slots[0], championIds: [...node.championIds] });
        }
        const target = lineage[lineage.length - 1];
        return {
            path: lineage.slice(0, -1),
            targetSlot: target.slot,
            championIds: node.championIds,
            side: node.side
        };
    };
    const menuActions = (
        m: NonNullable<ReturnType<typeof menu>>
    ): ContextMenuAction[] => {
        const label = turnLabelForSlots(m.node.slots);
        const actions: ContextMenuAction[] = [];
        if (canMutate()) {
            actions.push({
                label: "Swap champion",
                destructive: true,
                action: () => {
                    const target = deriveContentAddressedTarget(
                        indexPathFor(m.depth, m.index)
                    );
                    const oldChampionId = target?.championIds[0];
                    if (target && oldChampionId)
                        setSwapTarget({
                            path: target.path,
                            targetSlot: target.targetSlot,
                            oldChampionId,
                            contextLabel: label,
                            side: target.side
                        });
                }
            });
            actions.push({
                label: "Create branch with champion…",
                action: () => {
                    const target = deriveContentAddressedTarget(
                        indexPathFor(m.depth, m.index)
                    );
                    if (target)
                        setBranchTarget({
                            path: target.path,
                            targetSlot: target.targetSlot,
                            contextLabel: label,
                            side: target.side
                        });
                }
            });
        }
        actions.push({
            label: "Copy champion name",
            action: () => {
                const text = m.node.championIds.map(nameOf).join(" + ");
                navigator.clipboard
                    .writeText(text)
                    .then(() => toast.success(`Copied "${text}"`))
                    .catch(() => toast.error("Failed to copy to clipboard"));
            }
        });
        return actions;
    };
    const pickerColoring =
        (side: "blue" | "red" | null) =>
        (championId: string): ChampionColorState => {
            const s = session();
            return s
                ? getPickerState(
                      championId,
                      side,
                      s.blue_pool,
                      s.red_pool,
                      usedChampionIdSet()
                  )
                : "neutral";
        };

    return (
        <>
            <div ref={(el) => (pageEl = el)} class="relative flex h-full w-full flex-col">
                <Show when={session()}>
                    {(s) => (
                        <SeriesTabStrip
                            session={s()}
                            activeDraft={activeDraft()}
                            completedGames={completedGames()}
                            viewingGameNumber={viewingGameNumber()}
                            onViewGame={viewGame}
                        />
                    )}
                </Show>

                {/* Header row (design § 1) */}
                <div
                    data-drafting-header
                    class="flex items-center gap-4 border-b border-darius-border/60 bg-darius-card px-4 py-2"
                >
                    <div>
                        <div class="text-[10px] uppercase tracking-wider text-slate-400">
                            Draft Navigator
                        </div>
                        <div class="text-sm font-semibold text-slate-50">
                            <Show
                                when={nextTurn()}
                                fallback={<span>Draft complete</span>}
                            >
                                {(t) => (
                                    <>
                                        {PHASE_LABELS[t().phase]} —{" "}
                                        {turnLabel(nextSlot() ?? 0)}
                                        <span
                                            class={`ml-2 text-xs font-normal ${t().side === "blue" ? "text-blue-300" : "text-red-300"}`}
                                        >
                                            {t().side} on the clock
                                            {t().side === ourSide() ? " · you" : ""}
                                        </span>
                                    </>
                                )}
                            </Show>
                        </div>
                    </div>
                    <div class="ml-auto flex items-center gap-2">
                        <Show
                            when={viewingGameNumber() !== null}
                            fallback={<EngineStatusPill status={status()} />}
                        >
                            <span
                                data-reviewing-game
                                class="rounded-full border border-slate-500/40 bg-slate-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-200"
                            >
                                Reviewing Game {viewingGameNumber()}
                            </span>
                        </Show>
                        <Show when={stale() && viewingGameNumber() === null}>
                            <button
                                type="button"
                                data-stale-pill
                                title={
                                    canEditPools()
                                        ? "Re-bucket now"
                                        : "Re-bucket between games"
                                }
                                onClick={() =>
                                    canEditPools()
                                        ? openRebucketReview()
                                        : toast(
                                              "Pools can be re-bucketed between games",
                                              { icon: "ℹ️" }
                                          )
                                }
                                class="rounded-full border border-amber-500/60 bg-amber-950/40 px-3 py-1 text-xs text-amber-300"
                            >
                                ⚠ Saved pool uses old role buckets · re-bucket
                            </button>
                        </Show>
                        <Show when={canMutate()}>
                            <button
                                type="button"
                                data-undo
                                disabled={confirmedEvents().length === 0}
                                onClick={undo}
                                class="rounded-full border border-darius-border px-3 py-1 text-xs text-slate-200 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Undo
                            </button>
                            <button
                                type="button"
                                data-open-palette
                                onClick={() => openPalette(null)}
                                disabled={!canOpenPalette()}
                                class="rounded-full border border-darius-border px-3 py-1 text-xs text-slate-200 hover:border-slate-400 disabled:opacity-50"
                            >
                                Command{" "}
                                <kbd class="ml-1 rounded border border-slate-600 px-1 text-[10px]">
                                    /
                                </kbd>
                            </button>
                        </Show>
                    </div>
                </div>

                {/* Timeline row */}
                <NavigatorTimeline
                    events={confirmedEvents()}
                    nextSlot={turnIsOpen() ? nextSlot() : null}
                    ourSide={ourSide()}
                    readOnly={!turnIsOpen()}
                    gapText={gapText()}
                    onNextSlotClick={(el) => openPalette(el)}
                />

                {/* Columns row, or the between-games panel, or the archive card */}
                <Show
                    when={showBetweenGamesPanel() && session() && activeDraft()}
                    fallback={
                        <Show
                            when={viewingArchive()}
                            fallback={
                                <NavigatorColumns
                                    columns={columns()}
                                    ourSide={ourSide()}
                                    dimmed={computing()}
                                    canMutate={canMutate()}
                                    emptyReason={
                                        status().kind === "empty"
                                            ? emptyFanReason(
                                                  picksOf("blue"),
                                                  picksOf("red"),
                                                  nameOf
                                              )
                                            : null
                                    }
                                    canEditPools={canEditPools()}
                                    canUndo={confirmedEvents().length > 0}
                                    roleLineFor={roleLineFor}
                                    onSelect={(depth, index) =>
                                        setSelectedPath((p) => [
                                            ...p.slice(0, depth),
                                            index
                                        ])
                                    }
                                    onCommit={commitNode}
                                    onContextMenu={(args) => setMenu(args)}
                                    onUndo={undo}
                                    onEditPools={() =>
                                        canEditPools()
                                            ? setPoolEditOpen(true)
                                            : toast("Pools can be edited between games", {
                                                  icon: "ℹ️"
                                              })
                                    }
                                />
                            }
                        >
                            {(archive) => (
                                <div
                                    data-archive-card
                                    class="m-4 max-w-md self-start rounded-lg border border-slate-600 bg-darius-card p-4 text-sm text-slate-200"
                                >
                                    <div class="font-semibold">
                                        Game {archive().draft.game_number} complete —
                                        timeline only
                                    </div>
                                    <div class="mt-1 text-slate-400">
                                        The engine's projections at each decision aren't
                                        persisted — only a game's final snapshot is.
                                    </div>
                                    <button
                                        type="button"
                                        data-back-to-current
                                        onClick={() => viewGame(null)}
                                        class="mt-3 rounded border border-darius-border px-2 py-1 text-xs text-slate-200 hover:border-slate-400"
                                    >
                                        Back to the current game
                                    </button>
                                </div>
                            )}
                        </Show>
                    }
                >
                    <div class="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
                        <Show when={session()}>
                            {(s) => (
                                <Show when={activeDraft()}>
                                    {(d) => (
                                        <BetweenGamesPanel
                                            session={s()}
                                            completedDraft={d()}
                                            isSeriesComplete={isSeriesComplete()}
                                            onStartNextGame={(override) =>
                                                startNextGame(override)
                                            }
                                            onSavePools={(blue, red) =>
                                                updateSessionPools(blue, red)
                                            }
                                        />
                                    )}
                                </Show>
                            )}
                        </Show>
                    </div>
                </Show>

                <NavigatorCommandPalette
                    open={palette() !== null}
                    anchor={palette()?.anchor ?? null}
                    heading={paletteHeading()}
                    commands={commands()}
                    turn={paletteTurn()}
                    fan={fan()}
                    unavailable={unavailable()}
                    unavailableReason={unavailableReason}
                    coloring={coloring}
                    rankedRoleLine={rankedRoleLine}
                    preview={preview}
                    canvases={canvasListQuery.data ?? []}
                    canvasesLoading={
                        canvasListQuery.isPending && canvasListQuery.isFetching
                    }
                    defaultCanvasId={rememberedCanvasId()}
                    onCommit={commitChampions}
                    onExplore={explore}
                    onRun={runCommand}
                    onExport={(id) => {
                        if (selectedNodes().length === 0) {
                            toast(
                                "The selected line is no longer available — select again"
                            );
                            closePalette();
                            return;
                        }
                        void exportLine(id);
                    }}
                    onClose={closePalette}
                />
            </div>

            <Show when={menu()}>
                {(m) => (
                    <ContextMenu
                        position={{ x: m().x, y: m().y }}
                        actions={menuActions(m())}
                        header={m().node.championIds.map(nameOf).join(" + ")}
                        onClose={() => setMenu(null)}
                    />
                )}
            </Show>
            <Show when={swapTarget()}>
                {(target) => (
                    <ChampionPicker
                        isOpen={true}
                        onClose={() => setSwapTarget(null)}
                        onSelect={(newChampionId) => {
                            swapChampion({
                                path: target().path,
                                targetSlot: target().targetSlot,
                                newChampionId
                            });
                            setSwapTarget(null);
                        }}
                        contextLabel={target().contextLabel}
                        actionVerb="Swap to"
                        disabledChampionIds={usedChampionIdSet()}
                        championColoring={pickerColoring(target().side)}
                    />
                )}
            </Show>
            <Show when={branchTarget()}>
                {(target) => (
                    <ChampionPicker
                        isOpen={true}
                        onClose={() => setBranchTarget(null)}
                        onSelect={(newChampionId) => {
                            createBranch({
                                path: target().path,
                                targetSlot: target().targetSlot,
                                newChampionId
                            });
                            setBranchTarget(null);
                        }}
                        contextLabel={target().contextLabel}
                        actionVerb="Add branch with"
                        disabledChampionIds={usedChampionIdSet()}
                        championColoring={pickerColoring(target().side)}
                    />
                )}
            </Show>
            <Show when={session()}>
                {(s) => (
                    <PoolEditModal
                        isOpen={poolEditOpen}
                        initialBluePool={seededPools()?.blue ?? s().blue_pool}
                        initialRedPool={seededPools()?.red ?? s().red_pool}
                        onSave={(blue, red) => updateSessionPools(blue, red)}
                        onClose={closePoolEditor}
                    />
                )}
            </Show>
        </>
    );
};

export default NavigatorDrafting;
