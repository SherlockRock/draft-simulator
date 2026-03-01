import { Component, createSignal, Show, createMemo } from "solid-js";
import toast from "solid-toast";
import { AlertTriangle, EyeOff, Check, Share2, User, Eye } from "lucide-solid";
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

    // Current active draft (first non-completed, or first)
    const currentDraft = createMemo(() => {
        const vd = versusDraft();
        if (!vd?.Drafts?.length) return null;
        return vd.Drafts.find((d) => !d.completed) ?? vd.Drafts[0];
    });

    // Compute suggested role based on team identity and current game's side assignment
    const suggestedRole = createMemo(() => {
        const vd = versusDraft();
        const identity = myTeamIdentity();
        const d = currentDraft();
        if (!vd || !identity || !d) return null;
        return getSuggestedRole(
            identity,
            d.blueSideTeam || 1,
            vd.blueTeamName,
            vd.redTeamName
        );
    });

    const isRoleTaken = (role: "blue_captain" | "red_captain") => {
        const parts = participants();
        if (!parts) return false;
        return parts.some((p) => p.role === role && p.isConnected);
    };

    const handleJoinRole = async (role: "blue_captain" | "red_captain" | "spectator") => {
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
            setCopied(true);
            toast.success("Link copied to clipboard");
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div class="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-slate-900 bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px] p-6">
            <Show
                when={isConnected() && !error()}
                fallback={
                    <div class="relative z-10 text-center">
                        <Show
                            when={error()}
                            fallback={
                                <div class="flex flex-col items-center gap-4">
                                    <div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-orange-400" />
                                    <span class="text-slate-400">
                                        Connecting to session...
                                    </span>
                                </div>
                            }
                        >
                            <div class="rounded-2xl border border-red-500/20 bg-slate-900/80 p-8 backdrop-blur-sm">
                                <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-red-500/10">
                                    <AlertTriangle size={32} class="text-red-400" />
                                </div>
                                <h1 class="mb-2 text-xl font-semibold text-slate-50">
                                    Connection Error
                                </h1>
                                <p class="text-slate-400">{error()}</p>
                            </div>
                        </Show>
                    </div>
                }
            >
                <Show
                    when={versusDraft()}
                    fallback={
                        <div class="relative z-10 rounded-2xl border border-slate-700/50 bg-slate-900/80 p-8 text-center backdrop-blur-sm">
                            <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-amber-500/10">
                                <EyeOff size={32} class="text-amber-400" />
                            </div>
                            <h1 class="mb-2 text-xl font-semibold text-slate-50">
                                Invalid Link
                            </h1>
                            <p class="text-slate-400">
                                This versus draft link is invalid or has expired
                            </p>
                        </div>
                    }
                >
                    <div class="relative z-10 w-full max-w-lg">
                        {/* Header card */}
                        <div class="mb-6 overflow-hidden rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-800/90 to-slate-900/90 shadow-2xl backdrop-blur-sm">
                            <div class="flex items-center gap-4 border-b border-slate-700/50 px-6 py-5">
                                <IconDisplay
                                    icon={versusDraft()?.icon}
                                    defaultIcon="⚔️"
                                    size="md"
                                    className="rounded-xl border border-slate-600/50 bg-slate-800"
                                />
                                <div class="min-w-0 flex-1">
                                    <h1 class="truncate text-xl font-bold tracking-tight text-slate-50">
                                        {versusDraft()?.name ?? ""}
                                    </h1>
                                    <div class="mt-1 flex items-center gap-2 text-sm">
                                        <span
                                            class={`rounded-md px-2 py-0.5 ${
                                                versusDraft()?.length === 1
                                                    ? "bg-indigo-500/20 text-indigo-300"
                                                    : versusDraft()?.length === 3
                                                      ? "bg-teal-500/20 text-teal-300"
                                                      : versusDraft()?.length === 5
                                                        ? "bg-emerald-500/20 text-emerald-300"
                                                        : "bg-pink-500/20 text-pink-300"
                                            }`}
                                        >
                                            Bo{versusDraft()?.length ?? 1}
                                        </span>
                                        <span
                                            class={`rounded-md px-2 py-0.5 ${
                                                versusDraft()?.competitive
                                                    ? "bg-amber-500/20 text-amber-300"
                                                    : "bg-sky-500/20 text-sky-300"
                                            }`}
                                        >
                                            {versusDraft()?.competitive
                                                ? "Competitive"
                                                : "Scrim"}
                                        </span>
                                        <Show when={versusDraft()?.type}>
                                            <span
                                                class={`rounded-md px-2 py-0.5 ${
                                                    versusDraft()?.type === "fearless"
                                                        ? "bg-fuchsia-500/20 text-fuchsia-300"
                                                        : versusDraft()?.type ===
                                                            "ironman"
                                                          ? "bg-lime-500/20 text-lime-300"
                                                          : "bg-cyan-500/20 text-cyan-300"
                                                }`}
                                            >
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
                                        <span class="text-lg font-semibold text-blue-400">
                                            {versusDraft()?.blueTeamName ?? ""}
                                        </span>
                                    </div>
                                    <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-slate-600 bg-slate-800 text-xs font-bold text-slate-500">
                                        VS
                                    </div>
                                    <div class="flex-1 text-left">
                                        <span class="text-lg font-semibold text-red-400">
                                            {versusDraft()?.redTeamName ?? ""}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Share button */}
                            <div class="border-t border-slate-700/50 px-6 py-4">
                                <button
                                    onClick={handleCopyLink}
                                    class="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-700/50 px-4 py-2.5 text-sm font-medium text-slate-200 transition-all hover:border-slate-500 hover:bg-slate-700"
                                >
                                    {copied() ? (
                                        <>
                                            <Check size={16} class="text-orange-400" />
                                            <span class="text-orange-400">
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
                            <h2 class="px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                                Choose Your Role
                            </h2>

                            {/* Blue Captain */}
                            <button
                                onClick={() => handleJoinRole("blue_captain")}
                                disabled={isRoleTaken("blue_captain") || isJoining()}
                                class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                                    isRoleTaken("blue_captain")
                                        ? "cursor-not-allowed border-slate-700/50 bg-slate-900/50 opacity-60"
                                        : suggestedRole() === "blue_captain"
                                          ? "cursor-pointer border-orange-400 bg-slate-800"
                                          : "cursor-pointer border-orange-500/30 bg-slate-800/80 hover:border-orange-400/60 hover:bg-slate-800"
                                }`}
                            >
                                <div
                                    class={`absolute inset-0 bg-gradient-to-r from-orange-600/10 to-transparent transition-opacity ${suggestedRole() === "blue_captain" && !isRoleTaken("blue_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                />
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div
                                            class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                                isRoleTaken("blue_captain")
                                                    ? "bg-slate-700"
                                                    : "bg-orange-500/20"
                                            }`}
                                        >
                                            <User
                                                size={20}
                                                class={isRoleTaken("blue_captain") ? "text-slate-500" : "text-orange-400"}
                                            />
                                        </div>
                                        <div>
                                            <div
                                                class={`font-semibold ${isRoleTaken("blue_captain") ? "text-slate-500" : "text-orange-400"}`}
                                            >
                                                {versusDraft()?.blueTeamName ?? ""}{" "}
                                                Captain
                                            </div>
                                            <div class="text-sm text-slate-500">
                                                Captain for{" "}
                                                {versusDraft()?.blueTeamName ?? ""}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <Show
                                            when={
                                                selectedRole() === "blue_captain" &&
                                                isJoining()
                                            }
                                        >
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-orange-400/30 border-t-orange-400" />
                                        </Show>
                                        <span
                                            class={`rounded px-2.5 py-1 text-xs font-medium ${
                                                isRoleTaken("blue_captain")
                                                    ? "bg-slate-700 text-slate-500"
                                                    : suggestedRole() === "blue_captain"
                                                      ? "bg-teal-500/15 text-teal-400"
                                                      : "bg-emerald-500/15 text-emerald-400"
                                            }`}
                                        >
                                            {isRoleTaken("blue_captain")
                                                ? "Taken"
                                                : suggestedRole() === "blue_captain"
                                                  ? "Previously Selected Role"
                                                  : "Open"}
                                        </span>
                                    </div>
                                </div>
                            </button>

                            {/* Red Captain */}
                            <button
                                onClick={() => handleJoinRole("red_captain")}
                                disabled={isRoleTaken("red_captain") || isJoining()}
                                class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                                    isRoleTaken("red_captain")
                                        ? "cursor-not-allowed border-slate-700/50 bg-slate-900/50 opacity-60"
                                        : suggestedRole() === "red_captain"
                                          ? "cursor-pointer border-orange-400 bg-slate-800"
                                          : "cursor-pointer border-orange-500/30 bg-slate-800/80 hover:border-orange-400/60 hover:bg-slate-800"
                                }`}
                            >
                                <div
                                    class={`absolute inset-0 bg-gradient-to-r from-orange-600/10 to-transparent transition-opacity ${suggestedRole() === "red_captain" && !isRoleTaken("red_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                />
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div
                                            class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                                isRoleTaken("red_captain")
                                                    ? "bg-slate-700"
                                                    : "bg-orange-500/20"
                                            }`}
                                        >
                                            <User
                                                size={20}
                                                class={isRoleTaken("red_captain") ? "text-slate-500" : "text-orange-400"}
                                            />
                                        </div>
                                        <div>
                                            <div
                                                class={`font-semibold ${isRoleTaken("red_captain") ? "text-slate-500" : "text-orange-400"}`}
                                            >
                                                {versusDraft()?.redTeamName ?? ""} Captain
                                            </div>
                                            <div class="text-sm text-slate-500">
                                                Captain for{" "}
                                                {versusDraft()?.redTeamName ?? ""}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <Show
                                            when={
                                                selectedRole() === "red_captain" &&
                                                isJoining()
                                            }
                                        >
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-orange-400/30 border-t-orange-400" />
                                        </Show>
                                        <span
                                            class={`rounded px-2.5 py-1 text-xs font-medium ${
                                                isRoleTaken("red_captain")
                                                    ? "bg-slate-700 text-slate-500"
                                                    : suggestedRole() === "red_captain"
                                                      ? "bg-teal-500/15 text-teal-400"
                                                      : "bg-emerald-500/15 text-emerald-400"
                                            }`}
                                        >
                                            {isRoleTaken("red_captain")
                                                ? "Taken"
                                                : suggestedRole() === "red_captain"
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
                                class="group relative w-full overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/50 p-4 text-left transition-all duration-200 hover:border-slate-600 hover:bg-slate-800/80"
                            >
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-700/50">
                                            <Eye size={20} class="text-slate-400" />
                                        </div>
                                        <div>
                                            <div class="font-semibold text-slate-300">
                                                Spectator
                                            </div>
                                            <div class="text-sm text-slate-500">
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
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-400" />
                                        </Show>
                                        <span class="rounded bg-slate-700/50 px-2.5 py-1 text-xs font-medium text-slate-400">
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
