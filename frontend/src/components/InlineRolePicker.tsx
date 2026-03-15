import { Component, Show, createSignal, createMemo } from "solid-js";
import { User, Eye, X } from "lucide-solid";
import { useVersusContext } from "../contexts/VersusContext";
import { getSuggestedRole } from "../workflows/VersusWorkflow";

const InlineRolePicker: Component = () => {
    const { versusContext, selectRole, hideRolePicker, myTeamIdentity } = useVersusContext();
    const [isJoining, setIsJoining] = createSignal(false);
    const [selectedRole, setSelectedRole] = createSignal<string | null>(null);

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const participants = createMemo(() => versusContext().participants);

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

    const handleSelectRole = (role: "team1_captain" | "team2_captain" | "spectator") => {
        setIsJoining(true);
        setSelectedRole(role);
        selectRole(role);
        // Reset after timeout in case response is delayed
        setTimeout(() => {
            setIsJoining(false);
            setSelectedRole(null);
        }, 2000);
    };

    return (
        <div class="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
            <div class="w-full max-w-md rounded-2xl border border-slate-700/50 bg-slate-800 p-6 shadow-2xl">
                {/* Header */}
                <div class="mb-5 flex items-center justify-between">
                    <h2 class="text-lg font-semibold text-slate-50">
                        Choose Your Role
                    </h2>
                    <button
                        onClick={hideRolePicker}
                        class="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Role buttons */}
                <div class="space-y-3">
                    {/* Team 1 Captain */}
                    <button
                        onClick={() => handleSelectRole("team1_captain")}
                        disabled={isRoleTaken("team1_captain") || isJoining()}
                        class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                            isRoleTaken("team1_captain")
                                ? "cursor-not-allowed border-slate-700/50 bg-slate-900/50 opacity-60"
                                : suggestedRole() === "team1_captain"
                                  ? "cursor-pointer border-orange-400 bg-slate-800"
                                  : "cursor-pointer border-orange-500/30 bg-slate-800/80 hover:border-orange-400/60 hover:bg-slate-800"
                        }`}
                    >
                        <div
                            class={`absolute inset-0 bg-gradient-to-r from-orange-600/10 to-transparent transition-opacity ${suggestedRole() === "team1_captain" && !isRoleTaken("team1_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                        />
                        <div class="relative flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div
                                    class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                        isRoleTaken("team1_captain")
                                            ? "bg-slate-700"
                                            : "bg-orange-500/20"
                                    }`}
                                >
                                    <User
                                        size={20}
                                        class={
                                            isRoleTaken("team1_captain")
                                                ? "text-slate-500"
                                                : "text-orange-400"
                                        }
                                    />
                                </div>
                                <div>
                                    <div
                                        class={`font-semibold ${isRoleTaken("team1_captain") ? "text-slate-500" : "text-orange-400"}`}
                                    >
                                        {versusDraft()?.blueTeamName ?? ""} Captain
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <Show
                                    when={selectedRole() === "team1_captain" && isJoining()}
                                >
                                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-orange-400/30 border-t-orange-400" />
                                </Show>
                                <span
                                    class={`rounded px-2.5 py-1 text-xs font-medium ${
                                        isRoleTaken("team1_captain")
                                            ? "bg-slate-700 text-slate-500"
                                            : suggestedRole() === "team1_captain"
                                              ? "bg-teal-500/15 text-teal-400"
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
                        onClick={() => handleSelectRole("team2_captain")}
                        disabled={isRoleTaken("team2_captain") || isJoining()}
                        class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                            isRoleTaken("team2_captain")
                                ? "cursor-not-allowed border-slate-700/50 bg-slate-900/50 opacity-60"
                                : suggestedRole() === "team2_captain"
                                  ? "cursor-pointer border-orange-400 bg-slate-800"
                                  : "cursor-pointer border-orange-500/30 bg-slate-800/80 hover:border-orange-400/60 hover:bg-slate-800"
                        }`}
                    >
                        <div
                            class={`absolute inset-0 bg-gradient-to-r from-orange-600/10 to-transparent transition-opacity ${suggestedRole() === "team2_captain" && !isRoleTaken("team2_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                        />
                        <div class="relative flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div
                                    class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                        isRoleTaken("team2_captain")
                                            ? "bg-slate-700"
                                            : "bg-orange-500/20"
                                    }`}
                                >
                                    <User
                                        size={20}
                                        class={
                                            isRoleTaken("team2_captain")
                                                ? "text-slate-500"
                                                : "text-orange-400"
                                        }
                                    />
                                </div>
                                <div>
                                    <div
                                        class={`font-semibold ${isRoleTaken("team2_captain") ? "text-slate-500" : "text-orange-400"}`}
                                    >
                                        {versusDraft()?.redTeamName ?? ""} Captain
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <Show
                                    when={selectedRole() === "team2_captain" && isJoining()}
                                >
                                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-orange-400/30 border-t-orange-400" />
                                </Show>
                                <span
                                    class={`rounded px-2.5 py-1 text-xs font-medium ${
                                        isRoleTaken("team2_captain")
                                            ? "bg-slate-700 text-slate-500"
                                            : suggestedRole() === "team2_captain"
                                              ? "bg-teal-500/15 text-teal-400"
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
                        onClick={() => handleSelectRole("spectator")}
                        disabled={isJoining()}
                        class="group relative w-full overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/50 p-4 text-left transition-all duration-200 hover:border-slate-600 hover:bg-slate-800/80"
                    >
                        <div class="relative flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-700/50">
                                    <Eye size={20} class="text-slate-400" />
                                </div>
                                <div>
                                    <div class="font-semibold text-slate-300">Spectator</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <Show
                                    when={selectedRole() === "spectator" && isJoining()}
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
        </div>
    );
};

export default InlineRolePicker;
