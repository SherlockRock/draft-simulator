import { Component, Show, createMemo, createSignal } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { Pencil, Check, Share2 } from "lucide-solid";
import { useVersusContext } from "../contexts/VersusContext";
import { VersusChatPanel } from "./VersusChatPanel";
import { FlowBackLink } from "./FlowBackLink";
import { PickChangeModal } from "./PickChangeModal";
import { VersionFooter } from "./VersionFooter";
import { WinnerReporter } from "./WinnerReporter";
import { GameSettingsGrid } from "./GameSettingsGrid";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";
import { RoleSwitcher } from "./RoleSwitcher";
import { EditVersusDraftDialog } from "./EditVersusDraftDialog";
import { useQueryClient } from "@tanstack/solid-query";
import toast from "solid-toast";

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

    const canEditGameSettings = createMemo(() => {
        const role = myRole();
        const isCaptain = role === "blue_captain" || role === "red_captain";
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
                    {/* Series info card */}
                    <div class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                        <h2 class="text-base font-bold leading-tight text-slate-100">
                            {versusDraft()?.name ?? ""}
                        </h2>
                        <Show when={isOwner()}>
                            <button
                                onClick={() => setShowEditDialog(true)}
                                class="rounded p-1 text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-slate-200"
                                title="Edit series"
                            >
                                <Pencil size={16} />
                            </button>
                        </Show>
                    </div>

                    <RoleSwitcher
                        versusDraftId={params.id}
                        currentRole={myRole() || "spectator"}
                    />
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
                        onSettingsChange={handleSettingsChange}
                    />
                </div>
            </Show>

            {/* Invite Section */}
            <Show when={isInSeries() && versusDraft()}>
                <div class="px-3">
                    <button
                        onClick={handleCopyLink}
                        class="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-700/50 px-3 py-2 text-sm font-medium text-slate-200 transition-all hover:border-slate-500 hover:bg-slate-700"
                    >
                        {copied() ? (
                            <>
                                <Check size={16} class="text-orange-400" />
                                <span class="text-orange-400">Link Copied!</span>
                            </>
                        ) : (
                            <>
                                <Share2 size={16} />
                                Share Invite Link
                            </>
                        )}
                    </button>
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
                <div class="flex flex-col gap-2 px-3">
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
                            class={`w-full rounded px-3 py-1.5 text-sm font-medium transition-all active:scale-[0.98] ${
                                draftState()?.isPaused
                                    ? "border border-yellow-500/60 bg-yellow-500/15 font-bold text-yellow-400 hover:bg-yellow-500/25"
                                    : "border border-slate-600/50 bg-slate-700/50 text-slate-300 hover:bg-slate-600/50"
                            }`}
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
                            pendingRequest={
                                callbacks()?.pendingPickChangeRequest() ?? null
                            }
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
            </Show>

            {/* Chat Section - always visible when connected */}
            <Show when={isConnected() && versusDraft() && socket()}>
                <div class="min-h-0 flex-1 px-3">
                    <VersusChatPanel
                        socket={socket()!}
                        versusDraftId={versusDraft()?.id ?? ""}
                        currentRole={myRole()}
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
