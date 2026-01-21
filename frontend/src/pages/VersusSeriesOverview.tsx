import { Component, For, Show, createSignal, createMemo } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { draft } from "../utils/types";
import toast from "solid-toast";
import { useVersusContext } from "../workflows/VersusWorkflow";
import { RoleSwitcher } from "../components/RoleSwitcher";
import { IconDisplay } from "../components/IconDisplay";
import { WinnerReporter } from "../components/WinnerReporter";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";
import { EditVersusDraftDialog } from "../components/EditVersusDraftDialog";
import { useQueryClient } from "@tanstack/solid-query";

const VersusSeriesOverview: Component = () => {
    const params = useParams();
    const navigate = useNavigate();
    const { versusContext, socket } = useVersusContext();
    const accessor = useUser();
    const [user] = accessor();
    const userId = createMemo(() => user()?.id || null);

    const [copied, setCopied] = createSignal(false);
    const [showSharePopover, setShowSharePopover] = createSignal(false);
    const [showEditDialog, setShowEditDialog] = createSignal(false);
    const queryClient = useQueryClient();

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const myParticipant = createMemo(() => versusContext().myParticipant);
    const isConnected = createMemo(() => versusContext().connected);

    const myRole = createMemo(() => myParticipant()?.role || null);

    const isOwner = createMemo(() => {
        const vd = versusDraft();
        const uid = userId();
        return vd && uid && vd.owner_id === uid;
    });

    const handleCopyLink = () => {
        if (versusDraft()) {
            const link = `${window.location.origin}/versus/join/${versusDraft()!.shareLink}`;
            navigator.clipboard.writeText(link);
            setCopied(true);
            toast.success("Link copied to clipboard");
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const getDraftStatus = (draft: draft, index: number) => {
        if (draft.completed) return "complete";
        const drafts = versusDraft()?.Drafts || [];
        if (index > 0) {
            const allPreviousCompleted = drafts.slice(0, index).every((d) => d.completed);
            if (!allPreviousCompleted) return "locked";
        }
        const hasPicks = draft.picks && draft.picks.some((p) => p && p !== "");
        return hasPicks ? "active" : "upcoming";
    };

    const isDraftAccessible = (index: number) => {
        const drafts = versusDraft()?.Drafts || [];
        if (index === 0) return true;
        return drafts.slice(0, index).every((d) => d.completed);
    };

    const getWinnerDisplay = (winner?: "blue" | "red" | null) => {
        if (!winner) return null;
        return winner === "blue"
            ? versusDraft()?.blueTeamName
            : versusDraft()?.redTeamName;
    };

    const getSeriesScore = () => {
        const drafts = versusDraft()?.Drafts || [];
        let blueWins = 0;
        let redWins = 0;
        drafts.forEach((draft) => {
            if (draft.winner === "blue") blueWins++;
            if (draft.winner === "red") redWins++;
        });
        return { blueWins, redWins };
    };

    const getWinsNeeded = () => Math.ceil((versusDraft()?.length || 1) / 2);

    const handleReportWinner = (draftId: string, winner: "blue" | "red") => {
        const sock = socket();
        const vd = versusDraft();
        if (!sock || !vd) return;

        sock.emit("versusReportWinner", {
            versusDraftId: vd.id,
            draftId,
            winner
        });
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-950">
            <Show
                when={isConnected()}
                fallback={
                    <div class="flex h-full items-center justify-center">
                        <div class="flex items-center gap-3 text-slate-400">
                            <div class="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-teal-400" />
                            <span>Connecting to session...</span>
                        </div>
                    </div>
                }
            >
                <Show when={versusDraft()}>
                    {/* Ambient background gradient */}
                    <div class="pointer-events-none fixed inset-0 overflow-hidden">
                        <div class="absolute -left-1/4 -top-1/4 h-[600px] w-[600px] rounded-full bg-blue-600/[0.07] blur-[120px]" />
                        <div class="absolute -right-1/4 -top-1/4 h-[600px] w-[600px] rounded-full bg-red-600/[0.07] blur-[120px]" />
                    </div>

                    <div class="relative mx-auto max-w-5xl px-6 py-8">
                        {/* Top bar: Role switcher + Share popover */}
                        <div class="mb-8 flex items-center justify-between">
                            <RoleSwitcher
                                versusDraftId={params.id}
                                currentRole={myRole() || "spectator"}
                            />

                            <div class="flex items-center gap-2">
                                {/* Edit button - only for owner */}
                                <Show when={isOwner()}>
                                    <button
                                        onClick={() => setShowEditDialog(true)}
                                        class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-sm font-medium text-slate-300 transition-all hover:border-slate-600 hover:bg-slate-700/80 hover:text-slate-100"
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
                                        Edit
                                    </button>
                                </Show>

                                {/* Share popover */}
                                <div class="relative">
                                <button
                                    onClick={() =>
                                        setShowSharePopover(!showSharePopover())
                                    }
                                    class={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all ${
                                        showSharePopover()
                                            ? "border-teal-500/50 bg-slate-700/80 text-teal-300"
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
                                    <div class="absolute right-0 top-12 z-50 w-80 overflow-hidden rounded-xl border border-slate-600/50 bg-slate-800 shadow-xl">
                                        <div class="border-b border-slate-700/50 bg-slate-800/80 px-4 py-3">
                                            <div class="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                                Invite Link
                                            </div>
                                            <p class="mt-1 text-sm text-slate-400">
                                                Share to invite captains or spectators
                                            </p>
                                        </div>

                                        <div class="p-3">
                                            <div class="flex gap-2">
                                                <input
                                                    type="text"
                                                    readOnly
                                                    value={`${window.location.origin}/versus/join/${versusDraft()!.shareLink}`}
                                                    class="flex-1 rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm text-slate-200 focus:outline-none"
                                                />
                                                <button
                                                    onClick={handleCopyLink}
                                                    class="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white transition-all hover:bg-teal-500"
                                                >
                                                    {copied() ? (
                                                        <>
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
                                                            Copied
                                                        </>
                                                    ) : (
                                                        <>
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
                                                            Copy
                                                        </>
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
                            </div>
                        </div>

                        {/* Hero matchup section */}
                        <div class="mb-10 overflow-hidden rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-800/80 to-slate-900/80 shadow-2xl backdrop-blur-sm">
                            {/* Series name + icon header */}
                            <div class="flex items-center justify-between border-b border-slate-700/50 px-6 py-4">
                                <div class="flex items-center gap-4">
                                    <IconDisplay
                                        icon={versusDraft()!.icon}
                                        defaultIcon="⚔️"
                                        size="md"
                                        className="rounded-xl border border-slate-600/50 bg-slate-800"
                                    />
                                    <div>
                                        <h1 class="text-2xl font-bold tracking-tight text-slate-50">
                                            {versusDraft()!.name}
                                        </h1>
                                        <div class="mt-1 flex items-center gap-3 text-sm text-slate-400">
                                            <span class="rounded-md bg-slate-700/50 px-2 py-0.5">
                                                Best of {versusDraft()!.length}
                                            </span>
                                            <span
                                                class={`rounded-md px-2 py-0.5 ${
                                                    versusDraft()!.competitive
                                                        ? "bg-amber-500/20 text-amber-300"
                                                        : "bg-slate-700/50 text-slate-400"
                                                }`}
                                            >
                                                {versusDraft()!.competitive
                                                    ? "Competitive"
                                                    : "Scrim"}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Team matchup display */}
                            <div class="px-6 py-8">
                                <div class="flex items-center justify-center gap-6">
                                    {/* Blue team */}
                                    <div class="flex flex-1 items-center justify-end gap-4">
                                        <div class="text-right">
                                            <div class="text-2xl font-bold text-slate-100">
                                                {versusDraft()!.blueTeamName}
                                            </div>
                                            <Show
                                                when={
                                                    getSeriesScore().blueWins >=
                                                        getWinsNeeded() &&
                                                    getSeriesScore().blueWins >
                                                        getSeriesScore().redWins
                                                }
                                            >
                                                <div class="mt-1 inline-block rounded-full bg-blue-500/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-blue-300">
                                                    Winner
                                                </div>
                                            </Show>
                                        </div>
                                        <div class="flex h-14 w-14 items-center justify-center rounded-xl bg-blue-500/20 text-3xl font-black tabular-nums text-blue-400">
                                            {getSeriesScore().blueWins}
                                        </div>
                                    </div>

                                    {/* VS badge */}
                                    <div class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-2 border-slate-600 bg-slate-900 text-sm font-black tracking-tighter text-slate-500">
                                        VS
                                    </div>

                                    {/* Red team */}
                                    <div class="flex flex-1 items-center justify-start gap-4">
                                        <div class="flex h-14 w-14 items-center justify-center rounded-xl bg-red-500/20 text-3xl font-black tabular-nums text-red-400">
                                            {getSeriesScore().redWins}
                                        </div>
                                        <div class="text-left">
                                            <div class="text-2xl font-bold text-slate-100">
                                                {versusDraft()!.redTeamName}
                                            </div>
                                            <Show
                                                when={
                                                    getSeriesScore().redWins >=
                                                        getWinsNeeded() &&
                                                    getSeriesScore().redWins >
                                                        getSeriesScore().blueWins
                                                }
                                            >
                                                <div class="mt-1 inline-block rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-red-300">
                                                    Winner
                                                </div>
                                            </Show>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Description */}
                            <Show when={versusDraft()!.description}>
                                <div class="border-t border-slate-700/50 px-6 py-4">
                                    <p class="text-sm leading-relaxed text-slate-400">
                                        {versusDraft()!.description}
                                    </p>
                                </div>
                            </Show>
                        </div>

                        {/* Games grid */}
                        <div class="space-y-4">
                            <h2 class="text-lg font-semibold tracking-tight text-slate-300">
                                Games
                            </h2>

                            <div class="grid gap-3">
                                <For each={versusDraft()!.Drafts}>
                                    {(draft, index) => {
                                        const status = getDraftStatus(draft, index());
                                        const accessible = isDraftAccessible(index());
                                        const winner = getWinnerDisplay(draft.winner);

                                        return (
                                            <div
                                                onClick={() => {
                                                    if (accessible) {
                                                        navigate(
                                                            `/versus/${params.id}/draft/${draft.id}`
                                                        );
                                                    }
                                                }}
                                                class={`group relative overflow-hidden rounded-xl border transition-all duration-200 ${
                                                    accessible
                                                        ? "cursor-pointer border-slate-700/50 bg-slate-800/50 hover:border-slate-600 hover:bg-slate-800"
                                                        : "border-slate-800 bg-slate-900/50 opacity-60"
                                                }`}
                                            >
                                                {/* Left accent bar for winner */}
                                                <Show when={draft.winner}>
                                                    <div
                                                        class={`absolute left-0 top-0 h-full w-1 ${
                                                            draft.winner === "blue"
                                                                ? "bg-blue-500"
                                                                : "bg-red-500"
                                                        }`}
                                                    />
                                                </Show>

                                                <div class="flex items-center justify-between p-5">
                                                    <div class="flex items-center gap-4">
                                                        {/* Game number badge */}
                                                        <div
                                                            class={`flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold ${
                                                                status === "complete"
                                                                    ? draft.winner ===
                                                                      "blue"
                                                                        ? "bg-blue-500/20 text-blue-300"
                                                                        : "bg-red-500/20 text-red-300"
                                                                    : status === "active"
                                                                      ? "bg-teal-500/20 text-teal-300"
                                                                      : "bg-slate-700/50 text-slate-500"
                                                            }`}
                                                        >
                                                            {index() + 1}
                                                        </div>

                                                        <div class="flex items-center gap-3">
                                                            <h3 class="font-semibold text-slate-100">
                                                                Game {index() + 1}
                                                            </h3>

                                                            {/* Status indicator */}
                                                            <span
                                                                class={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                                                    status === "complete"
                                                                        ? "bg-green-500/20 text-green-300"
                                                                        : status ===
                                                                            "active"
                                                                          ? "bg-teal-500/20 text-teal-300"
                                                                          : status ===
                                                                              "locked"
                                                                            ? "bg-slate-700/50 text-slate-500"
                                                                            : "bg-slate-700/50 text-slate-400"
                                                                }`}
                                                            >
                                                                {status === "complete"
                                                                    ? "Complete"
                                                                    : status === "active"
                                                                      ? "In Progress"
                                                                      : status ===
                                                                          "locked"
                                                                        ? "Locked"
                                                                        : "Upcoming"}
                                                            </span>

                                                            {/* Winner display / reporter */}
                                                            <Show when={draft.completed}>
                                                                <WinnerReporter
                                                                    draftId={draft.id}
                                                                    blueTeamName={
                                                                        versusDraft()!
                                                                            .blueTeamName
                                                                    }
                                                                    redTeamName={
                                                                        versusDraft()!
                                                                            .redTeamName
                                                                    }
                                                                    currentWinner={
                                                                        draft.winner
                                                                    }
                                                                    canEdit={canReportWinner(
                                                                        draft,
                                                                        versusDraft()!,
                                                                        myRole(),
                                                                        userId()
                                                                    )}
                                                                    onReportWinner={(
                                                                        winner
                                                                    ) =>
                                                                        handleReportWinner(
                                                                            draft.id,
                                                                            winner
                                                                        )
                                                                    }
                                                                />
                                                            </Show>
                                                        </div>
                                                    </div>

                                                    {/* Right side: lock icon or arrow */}
                                                    <Show
                                                        when={accessible}
                                                        fallback={
                                                            <div class="text-slate-600">
                                                                <svg
                                                                    class="h-5 w-5"
                                                                    fill="none"
                                                                    viewBox="0 0 24 24"
                                                                    stroke="currentColor"
                                                                    stroke-width="2"
                                                                >
                                                                    <path
                                                                        stroke-linecap="round"
                                                                        stroke-linejoin="round"
                                                                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                                                    />
                                                                </svg>
                                                            </div>
                                                        }
                                                    >
                                                        <div class="text-slate-500 transition-transform duration-200 group-hover:translate-x-1 group-hover:text-slate-300">
                                                            <svg
                                                                class="h-5 w-5"
                                                                fill="none"
                                                                viewBox="0 0 24 24"
                                                                stroke="currentColor"
                                                                stroke-width="2"
                                                            >
                                                                <path
                                                                    stroke-linecap="round"
                                                                    stroke-linejoin="round"
                                                                    d="M9 5l7 7-7 7"
                                                                />
                                                            </svg>
                                                        </div>
                                                    </Show>
                                                </div>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </div>

                    {/* Edit Dialog */}
                    <Show when={versusDraft()}>
                        <EditVersusDraftDialog
                            isOpen={showEditDialog}
                            onClose={() => setShowEditDialog(false)}
                            versusDraft={versusDraft()!}
                            onSuccess={() => {
                                queryClient.invalidateQueries({ queryKey: ["versus", params.id] });
                            }}
                        />
                    </Show>
                </Show>
            </Show>
        </div>
    );
};

export default VersusSeriesOverview;
