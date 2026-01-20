import { Component, Show, createMemo } from "solid-js";
import { useParams } from "@solidjs/router";
import { useVersusContext } from "../workflows/VersusWorkflow";
import { VersusChatPanel } from "./VersusChatPanel";
import { PickChangeModal } from "./PickChangeModal";
import { VersionFooter } from "./VersionFooter";

const VersusFlowPanelContent: Component = () => {
    const params = useParams<{ id: string; draftId: string; linkToken: string }>();
    const { versusContext, socket, activeDraftState, draftCallbacks } =
        useVersusContext();

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

    return (
        <div class="flex h-full flex-col gap-4 pt-4">
            {/* Match Info Section - shown when in a series */}
            <Show when={isInSeries() && versusDraft()}>
                <div class="border-b border-slate-700 pb-4">
                    {/* Series Name */}
                    <div class="mb-3">
                        <div class="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            Series
                        </div>
                        <h2 class="text-sm font-bold leading-tight text-slate-100">
                            {versusDraft()!.name}
                        </h2>
                    </div>

                    {/* Match Details Grid */}
                    <div class="grid grid-cols-2 gap-2">
                        {/* Game Number - only when in draft view */}
                        <Show when={isInDraftView() && draftState()}>
                            <div class="rounded-lg bg-slate-900/50 p-2 ring-1 ring-slate-700/50">
                                <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                    Game
                                </div>
                                <div class="text-base font-bold text-teal-400">
                                    {draftState()?.draft?.seriesIndex !== undefined
                                        ? draftState()!.draft.seriesIndex + 1
                                        : "—"}
                                </div>
                            </div>
                        </Show>

                        {/* Your Role */}
                        <div class="rounded-lg bg-slate-900/50 p-2 ring-1 ring-slate-700/50">
                            <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                Role
                            </div>
                            <div class={`text-base font-bold ${getRoleColor(myRole())}`}>
                                {formatRole(myRole())}
                            </div>
                        </div>
                    </div>

                    {/* Draft Status Indicator - Paused */}
                    <Show
                        when={
                            isInDraftView() &&
                            draftState()?.isPaused &&
                            callbacks()?.draftStarted()
                        }
                    >
                        <div class="mt-3 rounded-lg border-2 border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-center backdrop-blur-sm">
                            <div class="flex items-center justify-center gap-2">
                                <span class="text-sm">⏸️</span>
                                <span class="text-xs font-bold uppercase tracking-wider text-yellow-400">
                                    Draft Paused
                                </span>
                            </div>
                        </div>
                    </Show>
                </div>
            </Show>

            {/* Draft Controls Section - only when viewing a draft */}
            <Show when={isInDraftView() && draftState() && callbacks() && !isSpectator()}>
                <div class="border-b border-slate-700 pb-4">
                    <h3 class="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Draft Controls
                    </h3>
                    <div class="space-y-2">
                        {/* Pause Button */}
                        <Show when={callbacks()?.draftStarted()}>
                            <button
                                onClick={() => callbacks()?.handlePause()}
                                class="w-full rounded-lg border-2 border-slate-600/50 bg-slate-700 px-3 py-2 text-xs font-bold text-slate-200 transition-all hover:border-slate-500 hover:bg-slate-600 active:scale-[0.98]"
                            >
                                {draftState()?.isPaused ? "Resume Draft" : "Pause Draft"}
                            </button>
                        </Show>

                        {/* Pick Change Modal */}
                        <Show when={draftState()?.draft && callbacks()}>
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
                <div class="min-h-0 flex-1">
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
