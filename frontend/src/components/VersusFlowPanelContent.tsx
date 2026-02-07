import { Component, Show, createMemo, createSignal } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { useVersusContext } from "../workflows/VersusWorkflow";
import { VersusChatPanel } from "./VersusChatPanel";
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
    const [showSharePopover, setShowSharePopover] = createSignal(false);
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
        return vd && uid && vd.owner_id === uid;
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
        <div class="flex h-full flex-col pt-4">
            {/* Back to Series - shown when viewing a draft */}
            <Show when={isInDraftView() && isInSeries()}>
                <div class="px-1 pb-3">
                    <button
                        onClick={() => navigate(`/versus/${params.id}`)}
                        class="group flex items-center gap-2 text-orange-400 transition-colors hover:text-orange-300"
                    >
                        <span class="transition-transform group-hover:-translate-x-1">
                            ←
                        </span>
                        <span class="text-sm font-medium">Back to Series</span>
                    </button>
                </div>
            </Show>

            {/* Match Info Section - shown when in a series */}
            <Show when={isInSeries() && versusDraft()}>
                <div class="px-1 pb-4">
                    {/* Series info card */}
                    <div class="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-900/40 p-3">
                        <h2 class="text-base font-bold leading-tight text-slate-100">
                            {versusDraft()?.name ?? ""}
                        </h2>
                        <Show when={isOwner()}>
                            <button
                                onClick={() => setShowEditDialog(true)}
                                class="rounded p-1 text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-slate-200"
                                title="Edit series"
                            >
                                <svg
                                    class="h-4 w-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    stroke-width="2"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                    />
                                </svg>
                            </button>
                        </Show>
                    </div>

                    <div class="mt-2">
                        <RoleSwitcher
                            versusDraftId={params.id}
                            currentRole={myRole() || "spectator"}
                        />
                    </div>
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

            {/* Invite Section */}
            <Show when={isInSeries() && versusDraft()}>
                <div class="relative border-t border-slate-700/50 px-1 py-4">
                    <button
                        onClick={() => setShowSharePopover(!showSharePopover())}
                        class={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all ${
                            showSharePopover()
                                ? "border-orange-500/50 bg-slate-700/80 text-orange-300"
                                : "border-slate-700 bg-slate-800/80 text-slate-300 hover:border-slate-600 hover:bg-slate-700/80 hover:text-slate-100"
                        }`}
                    >
                        <svg
                            class="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                            />
                        </svg>
                        Invite
                        <svg
                            class={`h-3 w-3 transition-transform ${showSharePopover() ? "rotate-180" : ""}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M19 9l-7 7-7-7"
                            />
                        </svg>
                    </button>

                    <Show when={showSharePopover()}>
                        <div class="absolute left-0 right-0 top-full z-50 overflow-hidden rounded-xl border border-slate-600/50 bg-slate-800 shadow-xl">
                            <div class="border-b border-slate-700/50 bg-slate-800/80 px-4 py-3">
                                <div class="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                    Invite Link
                                </div>
                                <p class="mt-1 text-sm text-slate-400">
                                    Share the link to invite captains or spectators
                                </p>
                            </div>

                            <div class="p-3">
                                <div class="flex min-w-0 gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={`${window.location.origin}/versus/join/${versusDraft()?.shareLink ?? ""}`}
                                        class="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm text-slate-200 focus:outline-none"
                                    />
                                    <button
                                        onClick={handleCopyLink}
                                        class="flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white transition-all hover:bg-orange-500"
                                    >
                                        {copied() ? (
                                            <svg
                                                class="h-4 w-4"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M5 13l4 4L19 7"
                                                />
                                            </svg>
                                        ) : (
                                            <svg
                                                class="h-4 w-4"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                                />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </Show>

                    <Show when={showSharePopover()}>
                        <div
                            class="fixed inset-0 z-40"
                            onClick={() => setShowSharePopover(false)}
                        />
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
