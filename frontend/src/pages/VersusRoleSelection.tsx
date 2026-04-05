import { Component, createSignal, Show, createMemo } from "solid-js";
import { Title, Meta } from "@solidjs/meta";
import toast from "solid-toast";
import { AlertTriangle, EyeOff, Check, Share2, User, Eye, Swords } from "lucide-solid";
import { track } from "../utils/analytics";
import { useVersusContext } from "../contexts/VersusContext";
import { getSuggestedRole } from "../workflows/VersusWorkflow";
import { IconDisplay } from "../components/IconDisplay";

const VersusRoleSelection: Component = () => {
    const { versusContext, selectRole, myTeamIdentity } = useVersusContext();
    const [isJoining, setIsJoining] = createSignal(false);
    const [selectedRole, setSelectedRole] = createSignal<string | null>(null);
    const [copied, setCopied] = createSignal(false);

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const participants = createMemo(() => versusContext().participants);
    const isConnected = createMemo(() => versusContext().connected);
    const error = createMemo(() => versusContext().error);

    // Compute suggested role based on team identity
    const suggestedRole = createMemo(() => {
        const vd = versusDraft();
        const identity = myTeamIdentity();
        if (!vd || !identity) return null;
        return getSuggestedRole(identity, vd.blueTeamName, vd.redTeamName);
    });

    const isRoleTaken = (role: "team1_captain" | "team2_captain") => {
        const parts = participants();
        if (!parts) return false;
        return parts.some((p) => p.role === role && p.isConnected);
    };

    const handleJoinRole = async (
        role: "team1_captain" | "team2_captain" | "spectator"
    ) => {
        if (!versusDraft()) return;

        setIsJoining(true);
        setSelectedRole(role);
        try {
            selectRole(role);
        } catch (error) {
            console.error("Failed to select role:", error);
        } finally {
            setTimeout(() => {
                setIsJoining(false);
                setSelectedRole(null);
            }, 2000);
        }
    };

    const handleCopyLink = () => {
        if (versusDraft()) {
            const link = `${window.location.origin}/versus/join/${versusDraft()?.shareLink ?? ""}`;
            navigator.clipboard.writeText(link);
            track("versus_shared");
            setCopied(true);
            toast.success("Link copied to clipboard");
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div class="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-darius-bg bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)] bg-[length:24px_24px] p-6">
            <Title>Join Versus - First Pick</Title>
            <Meta name="description" content="Join a live draft session." />
            <Show
                when={isConnected() && !error()}
                fallback={
                    <div class="relative z-10 text-center">
                        <Show
                            when={error()}
                            fallback={
                                <div class="flex flex-col items-center gap-4">
                                    <div class="h-8 w-8 animate-spin rounded-full border-2 border-darius-border border-t-darius-crimson" />
                                    <span class="text-darius-text-secondary">
                                        Connecting to session...
                                    </span>
                                </div>
                            }
                        >
                            <div class="rounded-2xl border border-red-500/20 bg-darius-bg/80 p-8 backdrop-blur-sm">
                                <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-red-500/10">
                                    <AlertTriangle size={32} class="text-red-400" />
                                </div>
                                <h1 class="mb-2 text-xl font-semibold text-darius-text-primary">
                                    Connection Error
                                </h1>
                                <p class="text-darius-text-secondary">{error()}</p>
                            </div>
                        </Show>
                    </div>
                }
            >
                <Show
                    when={versusDraft()}
                    fallback={
                        <div class="relative z-10 rounded-2xl border border-darius-border/50 bg-darius-bg/80 p-8 text-center backdrop-blur-sm">
                            <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-amber-500/10">
                                <EyeOff size={32} class="text-amber-400" />
                            </div>
                            <h1 class="mb-2 text-xl font-semibold text-darius-text-primary">
                                Invalid Link
                            </h1>
                            <p class="text-darius-text-secondary">
                                This versus draft link is invalid or has expired
                            </p>
                        </div>
                    }
                >
                    <div class="relative z-10 w-full max-w-lg">
                        {/* Header card */}
                        <div class="mb-6 overflow-hidden rounded-2xl border border-darius-border/50 bg-gradient-to-b from-darius-card/90 to-darius-bg/90 shadow-2xl backdrop-blur-sm">
                            <div class="flex items-center gap-4 border-b border-darius-border/50 px-6 py-5">
                                <IconDisplay
                                    icon={versusDraft()?.icon}
                                    defaultIcon={
                                        <Swords size={44} class="text-darius-crimson" />
                                    }
                                    size="md"
                                    class="rounded-xl border border-darius-border/50 bg-darius-card"
                                />
                                <div class="min-w-0 flex-1">
                                    <h1 class="truncate text-xl font-bold tracking-tight text-darius-text-primary">
                                        {versusDraft()?.name ?? ""}
                                    </h1>
                                    <div class="mt-1 flex items-center gap-2 text-sm">
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
                                                    versusDraft()?.type?.charAt(0) ?? ""
                                                ).toUpperCase() +
                                                    (versusDraft()?.type?.slice(1) ?? "")}
                                            </span>
                                        </Show>
                                    </div>
                                </div>
                            </div>

                            {/* Matchup display */}
                            <div class="px-6 py-5">
                                <div class="flex items-center justify-center gap-4">
                                    <div class="flex-1 text-right">
                                        <span class="text-lg font-semibold text-darius-crimson">
                                            {versusDraft()?.blueTeamName ?? ""}
                                        </span>
                                    </div>
                                    <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-darius-border bg-darius-card text-xs font-bold text-darius-text-secondary">
                                        VS
                                    </div>
                                    <div class="flex-1 text-left">
                                        <span class="text-lg font-semibold text-darius-purple-bright">
                                            {versusDraft()?.redTeamName ?? ""}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Share button */}
                            <div class="border-t border-darius-border/50 px-6 py-4">
                                <button
                                    onClick={handleCopyLink}
                                    class="flex w-full items-center justify-center gap-2 rounded-lg border border-darius-border bg-darius-card-hover/50 px-4 py-2.5 text-sm font-medium text-darius-text-primary transition-all"
                                >
                                    {copied() ? (
                                        <>
                                            <Check
                                                size={16}
                                                class="text-darius-crimson"
                                            />
                                            <span class="text-darius-crimson">
                                                Link Copied!
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <Share2 size={16} />
                                            Share Invite Link
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Role selection */}
                        <div class="space-y-3">
                            <h2 class="px-1 text-xs font-semibold uppercase tracking-wider text-darius-text-secondary">
                                Choose Your Role
                            </h2>

                            {/* Team 1 Captain */}
                            <button
                                onClick={() => handleJoinRole("team1_captain")}
                                disabled={isRoleTaken("team1_captain") || isJoining()}
                                class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                                    isRoleTaken("team1_captain")
                                        ? "cursor-not-allowed border-darius-border/50 bg-darius-bg/50 opacity-60"
                                        : suggestedRole() === "team1_captain"
                                          ? "cursor-pointer border-darius-crimson bg-darius-card"
                                          : "cursor-pointer border-darius-crimson/30 bg-darius-card bg-darius-card/80 hover:border-darius-crimson/60"
                                }`}
                            >
                                <div
                                    class={`absolute inset-0 bg-gradient-to-r from-darius-crimson/10 to-transparent transition-opacity ${suggestedRole() === "team1_captain" && !isRoleTaken("team1_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                />
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div
                                            class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                                isRoleTaken("team1_captain")
                                                    ? "bg-darius-card-hover"
                                                    : "bg-darius-crimson/20"
                                            }`}
                                        >
                                            <User
                                                size={20}
                                                class={
                                                    isRoleTaken("team1_captain")
                                                        ? "text-darius-text-secondary"
                                                        : "text-darius-crimson"
                                                }
                                            />
                                        </div>
                                        <div>
                                            <div
                                                class={`font-semibold ${isRoleTaken("team1_captain") ? "text-darius-text-secondary" : "text-darius-crimson"}`}
                                            >
                                                {versusDraft()?.blueTeamName ?? ""}{" "}
                                                Captain
                                            </div>
                                            <div class="text-sm text-darius-text-secondary">
                                                Captain for{" "}
                                                {versusDraft()?.blueTeamName ?? ""}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <Show
                                            when={
                                                selectedRole() === "team1_captain" &&
                                                isJoining()
                                            }
                                        >
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-darius-crimson/30 border-t-darius-crimson" />
                                        </Show>
                                        <span
                                            class={`rounded px-2.5 py-1 text-xs font-medium ${
                                                isRoleTaken("team1_captain")
                                                    ? "bg-darius-card-hover text-darius-text-secondary"
                                                    : suggestedRole() === "team1_captain"
                                                      ? "bg-darius-ember/15 text-darius-ember"
                                                      : "bg-emerald-500/15 text-emerald-400"
                                            }`}
                                        >
                                            {isRoleTaken("team1_captain")
                                                ? "Taken"
                                                : suggestedRole() === "team1_captain"
                                                  ? "Previously Selected Role"
                                                  : "Open"}
                                        </span>
                                    </div>
                                </div>
                            </button>

                            {/* Team 2 Captain */}
                            <button
                                onClick={() => handleJoinRole("team2_captain")}
                                disabled={isRoleTaken("team2_captain") || isJoining()}
                                class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                                    isRoleTaken("team2_captain")
                                        ? "cursor-not-allowed border-darius-border/50 bg-darius-bg/50 opacity-60"
                                        : suggestedRole() === "team2_captain"
                                          ? "cursor-pointer border-darius-purple-bright bg-darius-card"
                                          : "cursor-pointer border-darius-purple-bright/30 bg-darius-card bg-darius-card/80 hover:border-darius-purple-bright/60"
                                }`}
                            >
                                <div
                                    class={`absolute inset-0 bg-gradient-to-r from-darius-purple-bright/10 to-transparent transition-opacity ${suggestedRole() === "team2_captain" && !isRoleTaken("team2_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                />
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div
                                            class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                                isRoleTaken("team2_captain")
                                                    ? "bg-darius-card-hover"
                                                    : "bg-darius-purple-bright/20"
                                            }`}
                                        >
                                            <User
                                                size={20}
                                                class={
                                                    isRoleTaken("team2_captain")
                                                        ? "text-darius-text-secondary"
                                                        : "text-darius-purple-bright"
                                                }
                                            />
                                        </div>
                                        <div>
                                            <div
                                                class={`font-semibold ${isRoleTaken("team2_captain") ? "text-darius-text-secondary" : "text-darius-purple-bright"}`}
                                            >
                                                {versusDraft()?.redTeamName ?? ""} Captain
                                            </div>
                                            <div class="text-sm text-darius-text-secondary">
                                                Captain for{" "}
                                                {versusDraft()?.redTeamName ?? ""}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <Show
                                            when={
                                                selectedRole() === "team2_captain" &&
                                                isJoining()
                                            }
                                        >
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-darius-purple-bright/30 border-t-darius-purple-bright" />
                                        </Show>
                                        <span
                                            class={`rounded px-2.5 py-1 text-xs font-medium ${
                                                isRoleTaken("team2_captain")
                                                    ? "bg-darius-card-hover text-darius-text-secondary"
                                                    : suggestedRole() === "team2_captain"
                                                      ? "bg-darius-purple-bright/15 text-darius-purple-bright"
                                                      : "bg-emerald-500/15 text-emerald-400"
                                            }`}
                                        >
                                            {isRoleTaken("team2_captain")
                                                ? "Taken"
                                                : suggestedRole() === "team2_captain"
                                                  ? "Previously Selected Role"
                                                  : "Open"}
                                        </span>
                                    </div>
                                </div>
                            </button>

                            {/* Spectator */}
                            <button
                                onClick={() => handleJoinRole("spectator")}
                                disabled={isJoining()}
                                class="group relative w-full overflow-hidden rounded-xl border border-darius-border bg-darius-card/80 p-4 text-left transition-all duration-200"
                            >
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-darius-card-hover/50">
                                            <Eye
                                                size={20}
                                                class="text-darius-text-secondary"
                                            />
                                        </div>
                                        <div>
                                            <div class="font-semibold text-darius-text-secondary">
                                                Spectator
                                            </div>
                                            <div class="text-sm text-darius-text-secondary">
                                                Watch the draft unfold
                                            </div>
                                        </div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <Show
                                            when={
                                                selectedRole() === "spectator" &&
                                                isJoining()
                                            }
                                        >
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-darius-disabled/30 border-t-darius-disabled" />
                                        </Show>
                                        <span class="rounded bg-darius-card-hover/50 px-2.5 py-1 text-xs font-medium text-darius-text-secondary">
                                            Always Open
                                        </span>
                                    </div>
                                </div>
                            </button>
                        </div>
                    </div>
                </Show>
            </Show>
        </div>
    );
};

export default VersusRoleSelection;
