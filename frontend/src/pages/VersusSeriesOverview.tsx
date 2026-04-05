import { Component, For, Show, createMemo } from "solid-js";
import { Title } from "@solidjs/meta";
import { useParams, useNavigate } from "@solidjs/router";
import { Lock, ChevronRight, Flag, Swords } from "lucide-solid";
import { draft } from "../utils/schemas";
import { useVersusContext } from "../contexts/VersusContext";
import { IconDisplay } from "../components/IconDisplay";
import { WinnerReporter } from "../components/WinnerReporter";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";
import { gameTextColors } from "../utils/constants";

const VersusSeriesOverview: Component = () => {
    const params = useParams();
    const navigate = useNavigate();
    const { versusContext, reportWinner } = useVersusContext();
    const accessor = useUser();
    const [user] = accessor();
    const userId = createMemo(() => user()?.id || null);

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const myParticipant = createMemo(() => versusContext().myParticipant);
    const isConnected = createMemo(() => versusContext().connected);

    const myRole = createMemo(() => myParticipant()?.role || null);

    const getDraftStatus = (draft: draft, index: number) => {
        if (draft.completed) return "complete";
        // If series already decided, remaining games are locked
        if (isSeriesDecided()) return "locked";
        const drafts = versusDraft()?.Drafts || [];
        if (index > 0) {
            const allPreviousCompleted = drafts.slice(0, index).every((d) => d.completed);
            if (!allPreviousCompleted) return "locked";
        }
        const hasPicks = draft.picks && draft.picks.some((p) => p && p !== "");
        return hasPicks ? "active" : "upcoming";
    };

    const isDraftAccessible = (index: number) => {
        // If series already decided, only completed games are accessible
        if (isSeriesDecided()) {
            const drafts = versusDraft()?.Drafts || [];
            return drafts[index]?.completed === true;
        }
        const drafts = versusDraft()?.Drafts || [];
        if (index === 0) return true;
        return drafts.slice(0, index).every((d) => d.completed);
    };

    // const getWinnerDisplay = (winner?: "blue" | "red" | null) => {
    //     if (!winner) return null;
    //     return winner === "blue"
    //         ? versusDraft()?.blueTeamName
    //         : versusDraft()?.redTeamName;
    // };

    const getSeriesScore = () => {
        const drafts = versusDraft()?.Drafts || [];
        let team1Wins = 0;
        let team2Wins = 0;
        drafts.forEach((draft) => {
            if (!draft.winner) return;
            const bst = draft.blueSideTeam || 1;
            // Translate side-based winner to team-based winner
            const team1WonThisGame =
                (draft.winner === "blue" && bst === 1) ||
                (draft.winner === "red" && bst === 2);
            if (team1WonThisGame) team1Wins++;
            else team2Wins++;
        });
        return { blueWins: team1Wins, redWins: team2Wins };
    };

    // Translate a side-based winner to the team that actually won
    const getTeamWinner = (
        winner: "blue" | "red" | null | undefined,
        blueSideTeam: number | undefined
    ): "team1" | "team2" | null => {
        if (!winner) return null;
        const bst = blueSideTeam || 1;
        if (bst === 1) return winner === "blue" ? "team1" : "team2";
        return winner === "blue" ? "team2" : "team1";
    };

    const getWinsNeeded = () => Math.ceil((versusDraft()?.length || 1) / 2);

    const isSeriesDecided = createMemo(() => {
        const { blueWins, redWins } = getSeriesScore();
        const winsNeeded = getWinsNeeded();
        return blueWins >= winsNeeded || redWins >= winsNeeded;
    });

    const handleReportWinner = (draftId: string, winner: "blue" | "red") => {
        reportWinner(draftId, winner);
    };

    return (
        <div class="flex-1 overflow-auto bg-darius-bg bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <Title>
                {versusDraft()?.blueTeamName && versusDraft()?.redTeamName
                    ? `${versusDraft()?.blueTeamName} vs ${versusDraft()?.redTeamName} - First Pick`
                    : "Versus Series - First Pick"}
            </Title>
            <Show
                when={isConnected()}
                fallback={
                    <div class="flex h-full items-center justify-center">
                        <div class="flex items-center gap-3 text-darius-text-secondary">
                            <div class="h-5 w-5 animate-spin rounded-full border-2 border-darius-border border-t-darius-crimson" />
                            <span>Connecting to session...</span>
                        </div>
                    </div>
                }
            >
                <Show when={versusDraft()}>
                    <div class="mx-auto max-w-5xl px-6 py-8">
                        {/* Hero matchup section */}
                        <div class="mb-10 overflow-hidden rounded-2xl border border-darius-border/50 bg-gradient-to-b from-darius-card/90 to-darius-bg/90 shadow-2xl backdrop-blur-sm">
                            {/* Series name + icon header */}
                            <div class="flex items-center justify-between border-b border-darius-border/50 px-6 py-4">
                                <div class="flex items-center gap-4">
                                    <IconDisplay
                                        icon={versusDraft()?.icon}
                                        defaultIcon={
                                            <Swords
                                                size={44}
                                                class="text-darius-crimson"
                                            />
                                        }
                                        size="md"
                                        class="rounded-xl border border-darius-border/50 bg-darius-card"
                                    />
                                    <div>
                                        <h1 class="text-2xl font-bold tracking-tight text-darius-text-primary">
                                            {versusDraft()?.name ?? ""}
                                        </h1>
                                        <div class="mt-1 flex items-center gap-3 text-sm text-darius-text-secondary">
                                            <span class="bg-darius-crimson/12 rounded-md px-2 py-0.5 text-darius-crimson">
                                                Bo{versusDraft()?.length ?? 1}
                                            </span>
                                            <span class="bg-darius-crimson/12 rounded-md px-2 py-0.5 text-darius-crimson">
                                                {versusDraft()?.competitive
                                                    ? "Competitive"
                                                    : "Scrim"}
                                            </span>
                                            <Show when={versusDraft()?.type}>
                                                <span class="bg-darius-crimson/12 rounded-md px-2 py-0.5 text-darius-crimson">
                                                    {(
                                                        versusDraft()?.type?.charAt(0) ??
                                                        ""
                                                    ).toUpperCase() +
                                                        (versusDraft()?.type?.slice(1) ??
                                                            "")}
                                                </span>
                                            </Show>
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
                                            <div class="text-2xl font-bold text-darius-text-primary">
                                                {versusDraft()?.blueTeamName ?? ""}
                                            </div>
                                            <Show
                                                when={
                                                    getSeriesScore().blueWins >=
                                                        getWinsNeeded() &&
                                                    getSeriesScore().blueWins >
                                                        getSeriesScore().redWins
                                                }
                                            >
                                                <div class="mt-1 inline-block rounded bg-darius-crimson/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-darius-crimson">
                                                    Winner
                                                </div>
                                            </Show>
                                        </div>
                                        <div class="flex h-14 w-14 items-center justify-center rounded-xl bg-darius-crimson/20 text-3xl font-black tabular-nums text-darius-crimson">
                                            {getSeriesScore().blueWins}
                                        </div>
                                    </div>

                                    {/* VS badge */}
                                    <div class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border-2 border-darius-border bg-darius-bg text-sm font-black tracking-tighter text-darius-text-secondary">
                                        VS
                                    </div>

                                    {/* Red team */}
                                    <div class="flex flex-1 items-center justify-start gap-4">
                                        <div class="flex h-14 w-14 items-center justify-center rounded-xl bg-darius-purple-bright/20 text-3xl font-black tabular-nums text-darius-purple-bright">
                                            {getSeriesScore().redWins}
                                        </div>
                                        <div class="text-left">
                                            <div class="text-2xl font-bold text-darius-text-primary">
                                                {versusDraft()?.redTeamName ?? ""}
                                            </div>
                                            <Show
                                                when={
                                                    getSeriesScore().redWins >=
                                                        getWinsNeeded() &&
                                                    getSeriesScore().redWins >
                                                        getSeriesScore().blueWins
                                                }
                                            >
                                                <div class="mt-1 inline-block rounded bg-darius-purple-bright/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-darius-purple-bright">
                                                    Winner
                                                </div>
                                            </Show>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Description */}
                            <Show when={versusDraft()?.description}>
                                <div class="border-t border-darius-border/50 px-6 py-4">
                                    <p class="text-sm leading-relaxed text-darius-text-secondary">
                                        {versusDraft()?.description ?? ""}
                                    </p>
                                </div>
                            </Show>
                        </div>

                        {/* Games grid */}
                        <div class="space-y-4">
                            <h2 class="text-lg font-semibold tracking-tight text-darius-text-secondary">
                                Games
                            </h2>

                            <div class="grid gap-3">
                                <For each={versusDraft()?.Drafts ?? []}>
                                    {(draft, index) => {
                                        const status = getDraftStatus(draft, index());
                                        const accessible = isDraftAccessible(index());
                                        const winningTeam = getTeamWinner(
                                            draft.winner,
                                            draft.blueSideTeam
                                        );

                                        return (
                                            <div
                                                onClick={() => {
                                                    if (accessible) {
                                                        navigate(
                                                            `/versus/${params.id}/draft/${draft.id}`
                                                        );
                                                    }
                                                }}
                                                class={`group relative overflow-hidden rounded-xl border transition-colors duration-200 ${
                                                    accessible
                                                        ? "cursor-pointer border-darius-border bg-darius-card hover:bg-darius-card-hover"
                                                        : "border-darius-border/30 bg-darius-card text-darius-disabled"
                                                }`}
                                            >
                                                <div class="flex items-center justify-between gap-3 p-5">
                                                    {/* Left zone: game identity */}
                                                    <div class="flex min-w-0 items-center gap-4">
                                                        {/* Game number badge */}
                                                        <div
                                                            class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-sm font-bold ${
                                                                status === "complete"
                                                                    ? winningTeam ===
                                                                      "team1"
                                                                        ? "border-darius-crimson/30 bg-darius-crimson/10 text-darius-crimson"
                                                                        : winningTeam ===
                                                                            "team2"
                                                                          ? "border-darius-purple-bright/30 bg-darius-purple-bright/10 text-darius-purple-bright"
                                                                          : "border-darius-border/50 bg-darius-card-hover text-darius-text-secondary"
                                                                    : status === "active"
                                                                      ? "border-darius-crimson/30 bg-darius-crimson/10 text-darius-crimson"
                                                                      : status ===
                                                                          "locked"
                                                                        ? "border-darius-disabled/30 bg-darius-bg/50 text-darius-disabled"
                                                                        : "border-darius-border/50 bg-darius-card-hover text-darius-text-secondary"
                                                            }`}
                                                        >
                                                            {index() + 1}
                                                        </div>

                                                        <h3
                                                            class={`whitespace-nowrap font-semibold ${gameTextColors[index() + 1] ?? "text-darius-text-primary"}`}
                                                        >
                                                            Game {index() + 1}
                                                        </h3>

                                                        {/* Status indicator */}
                                                        <span
                                                            class={`hidden rounded px-2.5 py-0.5 text-xs font-medium min-[850px]:inline-flex ${
                                                                status === "complete"
                                                                    ? "bg-darius-crimson/20 text-darius-crimson"
                                                                    : status === "active"
                                                                      ? "bg-darius-crimson/20 text-darius-crimson"
                                                                      : status ===
                                                                          "locked"
                                                                        ? "bg-darius-card-hover/50 text-darius-text-secondary"
                                                                        : "bg-darius-card-hover/50 text-darius-text-secondary"
                                                            }`}
                                                        >
                                                            {status === "complete"
                                                                ? "Complete"
                                                                : status === "active"
                                                                  ? "In Progress"
                                                                  : status === "locked"
                                                                    ? "Locked"
                                                                    : "Upcoming"}
                                                        </span>
                                                    </div>

                                                    {/* Right zone: 1st pick + winner + nav */}
                                                    <div class="flex shrink-0 items-center gap-3">
                                                        {/* 1st pick chip */}
                                                        <Show
                                                            when={
                                                                status === "complete" ||
                                                                status === "active"
                                                            }
                                                        >
                                                            <span class="hidden items-center gap-1.5 rounded-md bg-darius-card-hover/50 px-2.5 py-1 text-xs font-medium text-darius-text-secondary min-[800px]:flex">
                                                                <Flag
                                                                    size={10}
                                                                    class="text-darius-crimson/70"
                                                                />
                                                                1st:{" "}
                                                                <span class="text-darius-text-secondary">
                                                                    {(() => {
                                                                        const bst =
                                                                            draft.blueSideTeam ||
                                                                            1;
                                                                        const blueName =
                                                                            bst === 1
                                                                                ? (versusDraft()
                                                                                      ?.blueTeamName ??
                                                                                  "")
                                                                                : (versusDraft()
                                                                                      ?.redTeamName ??
                                                                                  "");
                                                                        const redName =
                                                                            bst === 1
                                                                                ? (versusDraft()
                                                                                      ?.redTeamName ??
                                                                                  "")
                                                                                : (versusDraft()
                                                                                      ?.blueTeamName ??
                                                                                  "");
                                                                        return (draft.firstPick ||
                                                                            "blue") ===
                                                                            "blue"
                                                                            ? blueName
                                                                            : redName;
                                                                    })()}
                                                                </span>
                                                            </span>
                                                        </Show>

                                                        {/* Winner reporter */}
                                                        <Show when={draft.completed}>
                                                            <div class="relative hidden min-[650px]:inline-flex">
                                                                <span class="absolute -top-[22px] left-1/2 -translate-x-1/2 text-[10px] font-semibold uppercase tracking-wider text-darius-text-secondary">
                                                                    Winner
                                                                </span>
                                                                <WinnerReporter
                                                                    draftId={draft.id}
                                                                    blueTeamName={
                                                                        (draft.blueSideTeam ||
                                                                            1) === 1
                                                                            ? (versusDraft()
                                                                                  ?.blueTeamName ??
                                                                              "")
                                                                            : (versusDraft()
                                                                                  ?.redTeamName ??
                                                                              "")
                                                                    }
                                                                    redTeamName={
                                                                        (draft.blueSideTeam ||
                                                                            1) === 1
                                                                            ? (versusDraft()
                                                                                  ?.redTeamName ??
                                                                              "")
                                                                            : (versusDraft()
                                                                                  ?.blueTeamName ??
                                                                              "")
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
                                                            </div>
                                                        </Show>

                                                        {/* Nav icon */}
                                                        <Show
                                                            when={accessible}
                                                            fallback={
                                                                <div class="text-darius-disabled">
                                                                    <Lock size={20} />
                                                                </div>
                                                            }
                                                        >
                                                            <div class="text-darius-text-secondary transition-transform duration-200 group-hover:translate-x-1">
                                                                <ChevronRight size={20} />
                                                            </div>
                                                        </Show>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </div>
                </Show>
            </Show>
        </div>
    );
};

export default VersusSeriesOverview;
