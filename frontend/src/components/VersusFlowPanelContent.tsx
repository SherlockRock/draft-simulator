import { Component, Show, createMemo, createSignal } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { Pencil, Check, Share2, Pause, Play, RefreshCw, Swords } from "lucide-solid";
import { track } from "../utils/analytics";
import { useVersusContext } from "../contexts/VersusContext";
import { VersusChatPanel } from "./VersusChatPanel";
import { FlowBackLink } from "./FlowBackLink";
import { PickChangeModal } from "./PickChangeModal";
import { VersionFooter } from "./VersionFooter";
import { IconDisplay } from "./IconDisplay";
import { WinnerReporter } from "./WinnerReporter";
import { GameSettingsGrid } from "./GameSettingsGrid";
import { canReportWinner } from "../utils/versusPermissions";
import { getRestrictedChampionsByGame } from "../utils/seriesRestrictions";
import { useUser } from "../userProvider";
import { RoleSwitcher } from "./RoleSwitcher";
import { EditVersusDraftDialog } from "./EditVersusDraftDialog";
import { useQueryClient } from "@tanstack/solid-query";
import toast from "solid-toast";
import type { RestrictionMapEntry } from "./ChampionPanel";
import {
    getVersusPostCompletionEditWindowSeconds,
    isCaptainRoleReselectLocked,
    hasNewerStartedDraft
} from "../utils/versusCompletionWindow";

const VersusFlowPanelContent: Component = () => {
    const params = useParams<{ id: string; draftId: string; linkToken: string }>();
    const navigate = useNavigate();
    const {
        versusContext,
        socket,
        activeDraftState,
        draftCallbacks,
        reportWinner,
        setGameSettings
    } = useVersusContext();
    const accessor = useUser();
    const [user] = accessor();
    const userId = createMemo(() => user()?.id || null);
    const [copied, setCopied] = createSignal(false);
    const [showEditDialog, setShowEditDialog] = createSignal(false);

    // Refs for PickChangeModal external trigger (icon in title bar)
    const [openPickChangeModal, setOpenPickChangeModal] = createSignal<
        (() => void) | undefined
    >();
    const [pickChangeState, setPickChangeState] = createSignal<{
        isLocked: () => boolean;
        timeRemaining: () => number | null;
        hasChangeableSlots: () => boolean;
    }>();
    const queryClient = useQueryClient();

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const myParticipant = createMemo(() => versusContext().myParticipant);
    const myRole = createMemo(() => myParticipant()?.role || null);
    const isConnected = createMemo(() => versusContext().connected);

    // Determine current view
    const isInDraftView = createMemo(() => !!params.draftId);
    const isInSeries = createMemo(() => !!params.id && !params.linkToken);

    const isSpectator = () => myRole() === "spectator";

    const fallbackAction = () => toast.error("Action unavailable — try refreshing");

    const draftState = createMemo(() => activeDraftState());
    const callbacks = createMemo(() => draftCallbacks());

    const canEditWinner = createMemo(() => {
        const draft = draftState()?.draft;
        const vd = versusDraft();
        if (!draft || !vd) return false;
        return canReportWinner(draft, vd, myRole(), userId());
    });

    const isOwner = createMemo(() => {
        const vd = versusDraft();
        const uid = userId();
        return !!(vd && uid && vd.owner_id === uid);
    });
    const captainRoleReselectLocked = createMemo(() =>
        isCaptainRoleReselectLocked(versusDraft())
    );

    const canEditGameSettings = createMemo(() => {
        const role = myRole();
        const isCaptain = role === "team1_captain" || role === "team2_captain";
        return isCaptain || isOwner();
    });

    // Derive per-game team names based on side assignment
    const blueSideTeamName = createMemo(() => {
        const bst = draftState()?.draft?.blueSideTeam ?? 1;
        return bst === 1 ? versusDraft()?.blueTeamName : versusDraft()?.redTeamName;
    });
    const redSideTeamName = createMemo(() => {
        const bst = draftState()?.draft?.blueSideTeam ?? 1;
        return bst === 1 ? versusDraft()?.redTeamName : versusDraft()?.blueTeamName;
    });

    // Restricted champion map for pick change modal (series restrictions like fearless)
    const restrictedChampionGameMap = createMemo(() => {
        const vd = versusDraft();
        const d = draftState()?.draft;
        if (!vd || !d) return new Map<string, RestrictionMapEntry>();
        const byGame = getRestrictedChampionsByGame(
            vd.type || "standard",
            vd.Drafts || [],
            d.seriesIndex ?? 0
        );
        const map = new Map<string, RestrictionMapEntry>();
        for (const game of byGame) {
            const entries: [string[], number][] = [
                [game.blueBans, 0],
                [game.redBans, 5],
                [game.bluePicks, 10],
                [game.redPicks, 15]
            ];
            for (const [arr, offset] of entries) {
                arr.forEach((id, i) => {
                    if (id && id !== "")
                        map.set(id, {
                            label: `Game ${game.gameNumber}`,
                            colorIndex: game.gameNumber,
                            pickIndex: offset + i
                        });
                });
            }
        }
        return map;
    });

    const pickChangeTooltip = () => {
        const state = pickChangeState();
        if (!state) return "Request Pick Change";
        if (state.isLocked()) return "Picks Locked";
        const remaining = state.timeRemaining();
        if (remaining !== null && remaining > 0) {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            return `Request Pick Change (${m}:${s.toString().padStart(2, "0")})`;
        }
        return "Request Pick Change";
    };

    const pickChangeDisabled = () => {
        const state = pickChangeState();
        if (!state) return true;
        return state.isLocked() || !state.hasChangeableSlots();
    };

    const catFace = createMemo<{ eye: string; mouth: string; suffix: string }>(() => {
        const ds = draftState();
        if (!ds || !isInDraftView()) return { eye: "-", mouth: "ω", suffix: "" };
        if (ds.completed) return { eye: "-", mouth: "ω", suffix: "" };
        if (ds.isPaused) return { eye: "-", mouth: "ω", suffix: "" };
        if (!callbacks()?.draftStarted()) return { eye: "-", mouth: "ω", suffix: "" };
        const myTurn = callbacks()?.isMyTurn() ?? false;
        if (myTurn) return { eye: "◕", mouth: "ᴗ", suffix: "" };
        return { eye: "◕", mouth: ".", suffix: "" };
    });

    const handleSettingsChange = (
        draftId: string,
        settings: { firstPick?: "blue" | "red"; blueSideTeam?: 1 | 2 }
    ) => {
        setGameSettings(draftId, settings);
    };

    const handleReportWinner = (winner: "blue" | "red") => {
        const draft = draftState()?.draft;
        if (!draft) return;
        reportWinner(draft.id, winner);
    };

    const handleCopyLink = () => {
        const vd = versusDraft();
        if (vd) {
            const link = `${window.location.origin}/versus/join/${vd.shareLink ?? ""}`;
            navigator.clipboard.writeText(link);
            track("versus_shared");
            setCopied(true);
            toast.success("Link copied to clipboard");
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div class="flex h-full flex-col gap-3 py-3">
            {/* Back to Versus Dashboard - shown on series overview */}
            <Show when={isInSeries() && !isInDraftView()}>
                <FlowBackLink
                    flowType="versus"
                    label="Back to Versus Dashboard"
                    onClick={() => navigate("/versus")}
                />
            </Show>

            {/* Back to Series - shown when viewing a draft */}
            <Show when={isInDraftView() && isInSeries()}>
                <FlowBackLink
                    flowType="versus"
                    label="Back to Series"
                    onClick={() => navigate(`/versus/${params.id}`)}
                />
            </Show>

            {/* Match Info Section - shown when in a series */}
            <Show when={isInSeries() && versusDraft()}>
                <div class="flex flex-col gap-2 px-3">
                    {/* Two-row title card */}
                    <div class="group/bar overflow-hidden rounded-md border border-darius-crimson transition-colors hover:border-darius-crimson">
                        {/* Row 1: icon + name */}
                        <div class="flex items-center gap-2 bg-darius-card px-2.5 py-1.5">
                            {/* Series icon with description tooltip */}
                            <div class="group/icon relative flex-shrink-0">
                                <IconDisplay
                                    icon={versusDraft()?.icon}
                                    defaultIcon={
                                        <Swords size={22} class="text-darius-crimson" />
                                    }
                                    size="xs"
                                    class="rounded-md"
                                />
                                <Show when={versusDraft()?.description}>
                                    <div class="pointer-events-none absolute left-0 top-full z-50 mt-2 w-52 rounded-lg border border-darius-border/80 bg-darius-card px-3 py-2.5 text-xs leading-relaxed text-darius-text-secondary opacity-0 shadow-xl transition-opacity duration-200 group-hover/icon:opacity-100">
                                        <div class="absolute -top-1.5 left-3 h-3 w-3 rotate-45 border-l border-t border-darius-border/80 bg-darius-card" />
                                        <p class="relative">
                                            {versusDraft()?.description}
                                        </p>
                                    </div>
                                </Show>
                            </div>

                            <span class="min-w-0 flex-1 truncate text-sm font-medium text-darius-text-primary">
                                {versusDraft()?.name ?? ""}
                            </span>
                        </div>

                        {/* Row 2: cat mascot + action buttons */}
                        <div class="flex items-center border-t border-darius-crimson/50 bg-darius-card-hover text-darius-text-secondary">
                            {/* Cat mascot — reacts to draft state */}
                            <span class="min-w-0 flex-1 animate-cat-breathe select-none overflow-hidden whitespace-nowrap py-1 text-center text-xs text-darius-crimson">
                                =^<span class="animate-cat-blink">{catFace().eye}</span>
                                {catFace().mouth}
                                <span class="animate-cat-blink">{catFace().eye}</span>^=
                                {catFace().suffix}
                            </span>

                            <div class="ml-auto flex items-center">
                                {/* Pick Change icon */}
                                <Show
                                    when={
                                        isInDraftView() &&
                                        draftState()?.draft &&
                                        !isSpectator()
                                    }
                                >
                                    <button
                                        onClick={() => openPickChangeModal()?.()}
                                        disabled={pickChangeDisabled()}
                                        class={`flex items-center border-l border-darius-crimson/50 px-2.5 py-1.5 transition-colors ${
                                            pickChangeDisabled()
                                                ? "cursor-not-allowed text-darius-disabled"
                                                : "text-darius-crimson hover:bg-darius-crimson hover:text-darius-text-primary"
                                        }`}
                                        title={pickChangeTooltip()}
                                    >
                                        <RefreshCw size={14} />
                                    </button>
                                </Show>

                                <Show
                                    when={
                                        isInDraftView() &&
                                        callbacks()?.draftStarted() &&
                                        !draftState()?.completed &&
                                        !isSpectator()
                                    }
                                >
                                    <button
                                        onClick={() => callbacks()?.handlePause()}
                                        class="flex items-center border-l border-darius-crimson/50 px-2.5 py-1.5 text-darius-crimson transition-colors hover:bg-darius-crimson hover:text-darius-text-primary"
                                        title={
                                            draftState()?.isPaused
                                                ? "Resume draft"
                                                : "Pause draft"
                                        }
                                    >
                                        {draftState()?.isPaused ? (
                                            <Play size={14} />
                                        ) : (
                                            <Pause size={14} />
                                        )}
                                    </button>
                                </Show>

                                <button
                                    onClick={handleCopyLink}
                                    class="flex items-center border-l border-darius-crimson/50 px-2.5 py-1.5 text-darius-crimson transition-colors hover:bg-darius-crimson hover:text-darius-text-primary"
                                    title={
                                        copied() ? "Link copied!" : "Share invite link"
                                    }
                                >
                                    {copied() ? (
                                        <Check size={14} />
                                    ) : (
                                        <Share2 size={14} />
                                    )}
                                </button>

                                <Show when={isOwner()}>
                                    <button
                                        onClick={() => setShowEditDialog(true)}
                                        class="flex items-center border-l border-darius-crimson/50 px-2.5 py-1.5 text-darius-crimson transition-colors hover:bg-darius-crimson hover:text-darius-text-primary"
                                        title="Edit series"
                                    >
                                        <Pencil size={14} />
                                    </button>
                                </Show>
                            </div>
                        </div>
                    </div>

                    <Show when={!captainRoleReselectLocked()}>
                        <RoleSwitcher currentRole={myRole() || "spectator"} />
                    </Show>
                </div>
            </Show>

            {/* Game Settings Section - shown before draft starts for captains/owner */}
            <Show
                when={
                    isInDraftView() &&
                    draftState()?.draft &&
                    callbacks() &&
                    !callbacks()?.draftStarted() &&
                    !draftState()?.completed &&
                    canEditGameSettings()
                }
            >
                <div class="flex flex-col gap-2 px-3">
                    <div class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-darius-text-secondary">
                        Game Settings
                    </div>
                    <GameSettingsGrid
                        draftId={draftState()?.draft?.id ?? ""}
                        teamOneName={versusDraft()?.blueTeamName ?? ""}
                        teamTwoName={versusDraft()?.redTeamName ?? ""}
                        blueSideTeam={(draftState()?.draft?.blueSideTeam || 1) as 1 | 2}
                        firstPick={draftState()?.draft?.firstPick || "blue"}
                        canEdit={canEditGameSettings()}
                        onSettingsChange={handleSettingsChange}
                    />
                </div>
            </Show>

            {/* Winner Reporter - shown when draft is completed */}
            <Show
                when={
                    isInDraftView() &&
                    draftState()?.completed &&
                    draftState()?.draft &&
                    draftState()?.draftId === params.draftId
                }
            >
                <div class="flex justify-center px-3 pt-4">
                    <div class="relative">
                        <span class="absolute -top-[22px] left-1/2 -translate-x-1/2 text-[10px] font-semibold uppercase tracking-wider text-darius-text-secondary">
                            Winner
                        </span>
                        <WinnerReporter
                            draftId={draftState()?.draft?.id ?? ""}
                            blueTeamName={blueSideTeamName() ?? ""}
                            redTeamName={redSideTeamName() ?? ""}
                            currentWinner={draftState()?.draft?.winner}
                            canEdit={canEditWinner()}
                            onReportWinner={handleReportWinner}
                        />
                    </div>
                </div>
            </Show>

            {/* Pick Change Modal (button hidden — triggered from title bar icon) */}
            <Show
                when={
                    isInDraftView() &&
                    draftState()?.draft &&
                    draftState()?.draftId === params.draftId &&
                    callbacks() &&
                    !isSpectator()
                }
            >
                <PickChangeModal
                    draft={draftState()?.draft}
                    myRole={myRole}
                    isCompetitive={versusDraft()?.competitive ?? false}
                    blueTeamName={versusDraft()?.blueTeamName ?? ""}
                    redTeamName={versusDraft()?.redTeamName ?? ""}
                    completedAt={draftState()?.completedAt}
                    changeWindowSeconds={getVersusPostCompletionEditWindowSeconds(
                        versusDraft()?.competitive ?? false
                    )}
                    lockedBySeriesProgress={hasNewerStartedDraft(
                        versusDraft(),
                        draftState()?.draft?.id
                    )}
                    currentPickIndex={draftState()?.currentPickIndex ?? 0}
                    firstPick={draftState()?.draft?.firstPick ?? "blue"}
                    disabledChampions={versusDraft()?.disabledChampions ?? []}
                    restrictedChampionGameMap={restrictedChampionGameMap()}
                    pendingRequest={callbacks()?.pendingPickChangeRequest() ?? null}
                    onRequestChange={
                        callbacks()?.handleRequestPickChange ?? fallbackAction
                    }
                    onApproveChange={
                        callbacks()?.handleApprovePickChange ?? fallbackAction
                    }
                    onRejectChange={callbacks()?.handleRejectPickChange ?? fallbackAction}
                    hideButton={true}
                    onOpenRef={(fn) => {
                        setOpenPickChangeModal(() => fn);
                    }}
                    onStateRef={(state) => {
                        setPickChangeState(() => state);
                    }}
                />
            </Show>

            {/* Chat Section - always visible when connected */}
            <Show when={isConnected() && versusDraft() && socket()}>
                <div class="min-h-0 flex-1 px-3">
                    <VersusChatPanel
                        socket={socket()!}
                        versusDraftId={versusDraft()?.id ?? ""}
                        currentRole={myRole()}
                        isInDraftView={isInDraftView()}
                        blueSideTeam={(draftState()?.draft?.blueSideTeam ?? 1) as 1 | 2}
                    />
                </div>
            </Show>

            <VersionFooter />

            {/* Edit Dialog */}
            <Show when={versusDraft()}>
                <EditVersusDraftDialog
                    isOpen={showEditDialog}
                    onClose={() => setShowEditDialog(false)}
                    versusDraft={versusDraft()!}
                    onSuccess={() => {
                        queryClient.invalidateQueries({
                            queryKey: ["versus", params.id]
                        });
                    }}
                />
            </Show>
        </div>
    );
};

export default VersusFlowPanelContent;
