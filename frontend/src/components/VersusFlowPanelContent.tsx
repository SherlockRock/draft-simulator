import { Component, Show, createMemo } from "solid-js";
import { useParams } from "@solidjs/router";
import { useVersusContext } from "../workflows/VersusWorkflow";
import { VersusChatPanel } from "./VersusChatPanel";
import { PickChangeModal } from "./PickChangeModal";
import { VersionFooter } from "./VersionFooter";
import { WinnerReporter } from "./WinnerReporter";
import { GameSettingsGrid } from "./GameSettingsGrid";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";
import { RoleSwitcher } from "./RoleSwitcher";
import toast from "solid-toast";

const VersusFlowPanelContent: Component = () => {
    const params = useParams<{ id: string; draftId: string; linkToken: string }>();
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

    const canEditGameSettings = createMemo(() => {
        const role = myRole();
        const isCaptain = role === "blue_captain" || role === "red_captain";
        const isOwner = userId() === versusDraft()?.owner_id;
        return isCaptain || isOwner;
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

    const handleSetFirstPick = (draftId: string, firstPick: "blue" | "red") => {
        setGameSettings(draftId, { firstPick });
    };

    const handleSetBlueSideTeam = (draftId: string, blueSideTeam: 1 | 2) => {
        setGameSettings(draftId, { blueSideTeam });
    };

    const handleReportWinner = (winner: "blue" | "red") => {
        const draft = draftState()?.draft;
        if (!draft) return;
        reportWinner(draft.id, winner);
    };

    return (
        <div class="flex h-full flex-col pt-4">
            {/* Match Info Section - shown when in a series */}
            <Show when={isInSeries() && versusDraft()}>
                <div class="px-1 pb-4">
                    {/* Series info card */}
                    <div class="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3">
                        <h2 class="text-base font-bold leading-tight text-slate-100">
                            {versusDraft()?.name ?? ""}
                        </h2>
                    </div>

                    <div class="mt-2">
                        <RoleSwitcher
                            versusDraftId={params.id}
                            currentRole={myRole() || "spectator"}
                        />
                    </div>

                    {/* Draft Status Indicator - Paused */}
                    <Show
                        when={
                            isInDraftView() &&
                            draftState()?.isPaused &&
                            callbacks()?.draftStarted()
                        }
                    >
                        <div class="mt-3 flex items-center gap-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5">
                            <div class="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
                            <span class="text-xs font-semibold text-yellow-400">
                                Paused
                            </span>
                        </div>
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
                <div class="border-t border-slate-700/50 px-1 py-4">
                    <div class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        Game Settings
                    </div>
                    <GameSettingsGrid
                        draftId={draftState()?.draft?.id ?? ""}
                        teamOneName={versusDraft()?.blueTeamName ?? ""}
                        teamTwoName={versusDraft()?.redTeamName ?? ""}
                        blueSideTeam={(draftState()?.draft?.blueSideTeam || 1) as 1 | 2}
                        firstPick={draftState()?.draft?.firstPick || "blue"}
                        canEdit={canEditGameSettings()}
                        onSetFirstPick={handleSetFirstPick}
                        onSetBlueSideTeam={handleSetBlueSideTeam}
                    />
                </div>
            </Show>

            {/* Draft Controls Section - only when viewing a draft */}
            <Show
                when={
                    isInDraftView() &&
                    draftState() &&
                    ((callbacks() && !isSpectator()) || draftState()?.completed)
                }
            >
                <div class="border-t border-slate-700/50 px-1 py-4">
                    <div class="space-y-2">
                        {/* Winner Reporter - shown when draft is completed */}
                        <Show when={draftState()?.completed && draftState()?.draft}>
                            <div>
                                <div class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                                    Winner
                                </div>
                                <WinnerReporter
                                    draftId={draftState()?.draft?.id ?? ""}
                                    blueTeamName={blueSideTeamName() ?? ""}
                                    redTeamName={redSideTeamName() ?? ""}
                                    currentWinner={draftState()?.draft?.winner}
                                    canEdit={canEditWinner()}
                                    onReportWinner={handleReportWinner}
                                />
                            </div>
                        </Show>

                        {/* Pause Button */}
                        <Show
                            when={
                                callbacks()?.draftStarted() &&
                                !draftState()?.completed &&
                                !isSpectator()
                            }
                        >
                            <button
                                onClick={() => callbacks()?.handlePause()}
                                class="w-full rounded border border-slate-600/50 bg-slate-700/50 px-3 py-1.5 text-sm font-medium text-slate-300 transition-all hover:bg-slate-600/50 active:scale-[0.98]"
                            >
                                {draftState()?.isPaused ? "Resume Draft" : "Pause Draft"}
                            </button>
                        </Show>

                        {/* Pick Change Modal */}
                        <Show when={draftState()?.draft && callbacks() && !isSpectator()}>
                            <PickChangeModal
                                draft={draftState()?.draft}
                                myRole={myRole}
                                isCompetitive={versusDraft()?.competitive ?? false}
                                pendingRequest={callbacks()?.pendingPickChangeRequest()}
                                onRequestChange={
                                    callbacks()?.handleRequestPickChange ?? fallbackAction
                                }
                                onApproveChange={
                                    callbacks()?.handleApprovePickChange ?? fallbackAction
                                }
                                onRejectChange={
                                    callbacks()?.handleRejectPickChange ?? fallbackAction
                                }
                            />
                        </Show>
                    </div>
                </div>
            </Show>

            {/* Chat Section - always visible when connected */}
            <Show when={isConnected() && versusDraft() && socket()}>
                <div class="min-h-0 flex-1 border-t border-slate-700/50">
                    <VersusChatPanel
                        socket={socket()!}
                        versusDraftId={versusDraft()?.id ?? ""}
                        currentRole={myRole()}
                    />
                </div>
            </Show>

            <VersionFooter />
        </div>
    );
};

export default VersusFlowPanelContent;
