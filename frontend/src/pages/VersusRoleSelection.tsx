import { Component, createSignal, Show, createMemo } from "solid-js";
import toast from "solid-toast";
import { useVersusContext } from "../workflows/VersusWorkflow";
import { IconDisplay } from "../components/IconDisplay";

const VersusRoleSelection: Component = () => {
    const { versusContext, selectRole } = useVersusContext();
    const [isJoining, setIsJoining] = createSignal(false);
    const [selectedRole, setSelectedRole] = createSignal<string | null>(null);
    const [copied, setCopied] = createSignal(false);

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const participants = createMemo(() => versusContext().participants);
    const isConnected = createMemo(() => versusContext().connected);
    const error = createMemo(() => versusContext().error);

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
        } catch (error: any) {
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
            const link = `${window.location.origin}/versus/join/${versusDraft()!.shareLink}`;
            navigator.clipboard.writeText(link);
            setCopied(true);
            toast.success("Link copied to clipboard");
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div class="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-slate-950 p-6">
            {/* Ambient background gradients */}
            <div class="pointer-events-none absolute inset-0 overflow-hidden">
                <div class="absolute -left-1/4 top-1/4 h-[500px] w-[500px] rounded-full bg-blue-600/10 blur-[100px]" />
                <div class="absolute -right-1/4 top-1/4 h-[500px] w-[500px] rounded-full bg-red-600/10 blur-[100px]" />
                <div class="absolute bottom-0 left-1/2 h-[300px] w-[600px] -translate-x-1/2 rounded-full bg-slate-700/20 blur-[80px]" />
            </div>

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
                                    <svg
                                        class="h-8 w-8 text-red-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        stroke-width="2"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                        />
                                    </svg>
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
                                <svg
                                    class="h-8 w-8 text-amber-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    stroke-width="2"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                                    />
                                </svg>
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
                                    icon={versusDraft()!.icon}
                                    defaultIcon="⚔️"
                                    size="md"
                                    className="rounded-xl border border-slate-600/50 bg-slate-800"
                                />
                                <div class="min-w-0 flex-1">
                                    <h1 class="truncate text-xl font-bold tracking-tight text-slate-50">
                                        {versusDraft()!.name}
                                    </h1>
                                    <div class="mt-1 flex items-center gap-2 text-sm">
                                        <span
                                            class={`rounded-md px-2 py-0.5 ${
                                                versusDraft()!.length === 1
                                                    ? "bg-indigo-500/20 text-indigo-300"
                                                    : versusDraft()!.length === 3
                                                      ? "bg-teal-500/20 text-teal-300"
                                                      : versusDraft()!.length === 5
                                                        ? "bg-emerald-500/20 text-emerald-300"
                                                        : "bg-pink-500/20 text-pink-300"
                                            }`}
                                        >
                                            Bo{versusDraft()!.length}
                                        </span>
                                        <span
                                            class={`rounded-md px-2 py-0.5 ${
                                                versusDraft()!.competitive
                                                    ? "bg-amber-500/20 text-amber-300"
                                                    : "bg-sky-500/20 text-sky-300"
                                            }`}
                                        >
                                            {versusDraft()!.competitive
                                                ? "Competitive"
                                                : "Scrim"}
                                        </span>
                                        <Show when={versusDraft()!.type}>
                                            <span
                                                class={`rounded-md px-2 py-0.5 ${
                                                    versusDraft()!.type === "fearless"
                                                        ? "bg-fuchsia-500/20 text-fuchsia-300"
                                                        : versusDraft()!.type ===
                                                            "ironman"
                                                          ? "bg-lime-500/20 text-lime-300"
                                                          : "bg-cyan-500/20 text-cyan-300"
                                                }`}
                                            >
                                                {versusDraft()!
                                                    .type!.charAt(0)
                                                    .toUpperCase() +
                                                    versusDraft()!.type!.slice(1)}
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
                                            {versusDraft()!.blueTeamName}
                                        </span>
                                    </div>
                                    <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-slate-600 bg-slate-800 text-xs font-bold text-slate-500">
                                        VS
                                    </div>
                                    <div class="flex-1 text-left">
                                        <span class="text-lg font-semibold text-red-400">
                                            {versusDraft()!.redTeamName}
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
                                            <svg
                                                class="h-4 w-4 text-orange-400"
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
                                            <span class="text-orange-400">
                                                Link Copied!
                                            </span>
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
                                                    d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                                                />
                                            </svg>
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
                                        : "cursor-pointer border-blue-500/30 bg-slate-800/80 hover:border-blue-400/60 hover:bg-slate-800"
                                }`}
                            >
                                <div class="absolute inset-0 bg-gradient-to-r from-blue-600/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div
                                            class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                                isRoleTaken("blue_captain")
                                                    ? "bg-slate-700"
                                                    : "bg-blue-500/20"
                                            }`}
                                        >
                                            <svg
                                                class={`h-5 w-5 ${isRoleTaken("blue_captain") ? "text-slate-500" : "text-blue-400"}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                                                />
                                            </svg>
                                        </div>
                                        <div>
                                            <div
                                                class={`font-semibold ${isRoleTaken("blue_captain") ? "text-slate-500" : "text-blue-400"}`}
                                            >
                                                {versusDraft()!.blueTeamName} Captain
                                            </div>
                                            <div class="text-sm text-slate-500">
                                                Draft for the blue side
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
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-blue-400/30 border-t-blue-400" />
                                        </Show>
                                        <span
                                            class={`rounded px-2.5 py-1 text-xs font-medium ${
                                                isRoleTaken("blue_captain")
                                                    ? "bg-slate-700 text-slate-500"
                                                    : "bg-emerald-500/15 text-emerald-400"
                                            }`}
                                        >
                                            {isRoleTaken("blue_captain")
                                                ? "Taken"
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
                                        : "cursor-pointer border-red-500/30 bg-slate-800/80 hover:border-red-400/60 hover:bg-slate-800"
                                }`}
                            >
                                <div class="absolute inset-0 bg-gradient-to-r from-red-600/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                                <div class="relative flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div
                                            class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                                isRoleTaken("red_captain")
                                                    ? "bg-slate-700"
                                                    : "bg-red-500/20"
                                            }`}
                                        >
                                            <svg
                                                class={`h-5 w-5 ${isRoleTaken("red_captain") ? "text-slate-500" : "text-red-400"}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                                                />
                                            </svg>
                                        </div>
                                        <div>
                                            <div
                                                class={`font-semibold ${isRoleTaken("red_captain") ? "text-slate-500" : "text-red-400"}`}
                                            >
                                                {versusDraft()!.redTeamName} Captain
                                            </div>
                                            <div class="text-sm text-slate-500">
                                                Draft for the red side
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
                                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-red-400/30 border-t-red-400" />
                                        </Show>
                                        <span
                                            class={`rounded px-2.5 py-1 text-xs font-medium ${
                                                isRoleTaken("red_captain")
                                                    ? "bg-slate-700 text-slate-500"
                                                    : "bg-emerald-500/15 text-emerald-400"
                                            }`}
                                        >
                                            {isRoleTaken("red_captain")
                                                ? "Taken"
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
                                            <svg
                                                class="h-5 w-5 text-slate-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                                />
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                                />
                                            </svg>
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
