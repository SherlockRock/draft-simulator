import { Component, Show, createMemo } from "solid-js";
import { useParams } from "@solidjs/router";
import { useVersusContext } from "../workflows/VersusWorkflow";
import { VersusChatPanel } from "./VersusChatPanel";
import { PickChangeModal } from "./PickChangeModal";
import { VersionFooter } from "./VersionFooter";
import { WinnerReporter } from "./WinnerReporter";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";

const VersusFlowPanelContent: Component = () => {
    const params = useParams<{ id: string; draftId: string; linkToken: string }>();
    const { versusContext, socket, activeDraftState, draftCallbacks, reportWinner } =
        useVersusContext();
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

    const formatRole = (role: string | null) => {
        if (role === "blue_captain") return "Blue Captain";
        if (role === "red_captain") return "Red Captain";
        return "Spectator";
    };

    const getRoleColor = (role: string | null) => {
        if (role === "blue_captain") return "text-blue-400";
        if (role === "red_captain") return "text-red-400";
        return "text-slate-400";
    };

    const isSpectator = () => myRole() === "spectator";

    const draftState = createMemo(() => activeDraftState());
    const callbacks = createMemo(() => draftCallbacks());

    const canEditWinner = createMemo(() => {
        const draft = draftState()?.draft;
        const vd = versusDraft();
        if (!draft || !vd) return false;
        return canReportWinner(draft, vd, myRole(), userId());
    });

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
                    {/* Series header with name */}
                    <h2 class="mb-2 text-base font-bold leading-tight text-slate-100">
                        {versusDraft()!.name}
                    </h2>

                    {/* Compact metadata row */}
                    <div class="flex items-center gap-3 text-sm text-slate-400">
                        <Show when={isInDraftView() && draftState()}>
                            <span>
                                Game{" "}
                                <span class="font-bold text-slate-200">
                                    {draftState()?.draft?.seriesIndex !== undefined
                                        ? draftState()!.draft.seriesIndex + 1
                                        : "—"}
                                </span>
                            </span>
                            <span class="text-slate-600">|</span>
                        </Show>
                        <span class={getRoleColor(myRole())}>{formatRole(myRole())}</span>
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
                                    draftId={draftState()!.draft.id}
                                    blueTeamName={versusDraft()!.blueTeamName}
                                    redTeamName={versusDraft()!.redTeamName}
                                    currentWinner={draftState()!.draft.winner}
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
                                draft={draftState()!.draft}
                                myRole={myRole}
                                isCompetitive={versusDraft()!.competitive}
                                pendingRequest={callbacks()!.pendingPickChangeRequest()}
                                onRequestChange={callbacks()!.handleRequestPickChange}
                                onApproveChange={callbacks()!.handleApprovePickChange}
                                onRejectChange={callbacks()!.handleRejectPickChange}
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
                        versusDraftId={versusDraft()!.id}
                        currentRole={myRole()}
                    />
                </div>
            </Show>

            <VersionFooter />
        </div>
    );
};

export default VersusFlowPanelContent;
