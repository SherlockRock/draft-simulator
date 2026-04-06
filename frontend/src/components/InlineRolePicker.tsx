import { Component, Show, createSignal, createMemo } from "solid-js";
import { User, Eye, X } from "lucide-solid";
import { useVersusContext } from "../contexts/VersusContext";
import { getSuggestedRole } from "../workflows/VersusWorkflow";
import { isCaptainRoleReselectLocked } from "../utils/versusCompletionWindow";

const InlineRolePicker: Component = () => {
    const { versusContext, selectRole, hideRolePicker, myTeamIdentity } =
        useVersusContext();
    const [isJoining, setIsJoining] = createSignal(false);
    const [selectedRole, setSelectedRole] = createSignal<string | null>(null);

    const versusDraft = createMemo(() => versusContext().versusDraft);
    const participants = createMemo(() => versusContext().participants);
    const captainRolesLocked = createMemo(() =>
        isCaptainRoleReselectLocked(versusDraft())
    );

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
        <div
            class="absolute inset-0 z-20 flex items-center justify-center bg-darius-bg/80 backdrop-blur-sm"
            onClick={hideRolePicker}
        >
            <div
                class="w-full max-w-md rounded-2xl border border-darius-border/50 bg-darius-card p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div class="mb-5 flex items-center justify-between">
                    <h2 class="text-lg font-semibold text-darius-text-primary">
                        Choose Your Role
                    </h2>
                    <button
                        onClick={hideRolePicker}
                        class="p-1.5 text-darius-text-secondary transition-colors hover:text-darius-text-primary"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Role buttons */}
                <div class="space-y-3">
                    {/* Team 1 Captain */}
                    <button
                        onClick={() => handleSelectRole("team1_captain")}
                        disabled={
                            captainRolesLocked() ||
                            isRoleTaken("team1_captain") ||
                            isJoining()
                        }
                        class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                            captainRolesLocked() || isRoleTaken("team1_captain")
                                ? "cursor-not-allowed border-darius-border/50 bg-darius-bg/50 opacity-60"
                                : suggestedRole() === "team1_captain"
                                  ? "cursor-pointer border-darius-crimson bg-darius-card hover:border-darius-ember/60 hover:bg-darius-card-hover"
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
                                        captainRolesLocked() ||
                                        isRoleTaken("team1_captain")
                                            ? "bg-darius-card-hover"
                                            : "bg-darius-crimson/20"
                                    }`}
                                >
                                    <User
                                        size={20}
                                        class={
                                            captainRolesLocked() ||
                                            isRoleTaken("team1_captain")
                                                ? "text-darius-text-secondary"
                                                : "text-darius-crimson"
                                        }
                                    />
                                </div>
                                <div>
                                    <div
                                        class={`font-semibold ${
                                            captainRolesLocked() ||
                                            isRoleTaken("team1_captain")
                                                ? "text-darius-text-secondary"
                                                : "text-darius-crimson"
                                        }`}
                                    >
                                        {versusDraft()?.blueTeamName ?? ""} Captain
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <Show
                                    when={
                                        selectedRole() === "team1_captain" && isJoining()
                                    }
                                >
                                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-darius-crimson/30 border-t-darius-crimson" />
                                </Show>
                                <span
                                    class={`rounded px-2.5 py-1 text-xs font-medium ${
                                        isRoleTaken("team1_captain")
                                            ? "bg-darius-card-hover text-darius-text-secondary"
                                            : captainRolesLocked()
                                              ? "bg-darius-card-hover text-darius-text-secondary"
                                              : suggestedRole() === "team1_captain"
                                                ? "bg-darius-ember/15 text-darius-ember"
                                                : "bg-emerald-500/15 text-emerald-400"
                                    }`}
                                >
                                    {captainRolesLocked()
                                        ? "Locked"
                                        : isRoleTaken("team1_captain")
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
                        disabled={
                            captainRolesLocked() ||
                            isRoleTaken("team2_captain") ||
                            isJoining()
                        }
                        class={`group relative w-full overflow-hidden rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                            captainRolesLocked() || isRoleTaken("team2_captain")
                                ? "cursor-not-allowed border-darius-border/50 bg-darius-bg/50 opacity-60"
                                : suggestedRole() === "team2_captain"
                                  ? "cursor-pointer border-darius-crimson bg-darius-card hover:border-darius-ember/60 hover:bg-darius-card-hover"
                                  : "cursor-pointer border-darius-crimson/30 bg-darius-card bg-darius-card/80 hover:border-darius-crimson/60"
                        }`}
                    >
                        <div
                            class={`absolute inset-0 bg-gradient-to-r from-darius-crimson/10 to-transparent transition-opacity ${suggestedRole() === "team2_captain" && !isRoleTaken("team2_captain") ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                        />
                        <div class="relative flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div
                                    class={`flex h-10 w-10 items-center justify-center rounded-lg ${
                                        captainRolesLocked() ||
                                        isRoleTaken("team2_captain")
                                            ? "bg-darius-card-hover"
                                            : "bg-darius-crimson/20"
                                    }`}
                                >
                                    <User
                                        size={20}
                                        class={
                                            captainRolesLocked() ||
                                            isRoleTaken("team2_captain")
                                                ? "text-darius-text-secondary"
                                                : "text-darius-crimson"
                                        }
                                    />
                                </div>
                                <div>
                                    <div
                                        class={`font-semibold ${
                                            captainRolesLocked() ||
                                            isRoleTaken("team2_captain")
                                                ? "text-darius-text-secondary"
                                                : "text-darius-crimson"
                                        }`}
                                    >
                                        {versusDraft()?.redTeamName ?? ""} Captain
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <Show
                                    when={
                                        selectedRole() === "team2_captain" && isJoining()
                                    }
                                >
                                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-darius-crimson/30 border-t-darius-crimson" />
                                </Show>
                                <span
                                    class={`rounded px-2.5 py-1 text-xs font-medium ${
                                        isRoleTaken("team2_captain")
                                            ? "bg-darius-card-hover text-darius-text-secondary"
                                            : captainRolesLocked()
                                              ? "bg-darius-card-hover text-darius-text-secondary"
                                              : suggestedRole() === "team2_captain"
                                                ? "bg-darius-ember/15 text-darius-ember"
                                                : "bg-emerald-500/15 text-emerald-400"
                                    }`}
                                >
                                    {captainRolesLocked()
                                        ? "Locked"
                                        : isRoleTaken("team2_captain")
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
                        class="group relative w-full overflow-hidden rounded-xl border border-darius-border/50 bg-darius-card/80 p-4 text-left transition-all duration-200 hover:border-darius-disabled hover:bg-darius-card-hover"
                    >
                        <div class="relative flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-darius-card-hover/50">
                                    <Eye size={20} class="text-darius-text-secondary" />
                                </div>
                                <div>
                                    <div class="font-semibold text-darius-text-secondary">
                                        Spectator
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <Show
                                    when={selectedRole() === "spectator" && isJoining()}
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

                <Show when={captainRolesLocked()}>
                    <p class="mt-4 text-center text-xs text-darius-text-secondary">
                        Captain roles are locked because the completed series window has
                        expired.
                    </p>
                </Show>
            </div>
        </div>
    );
};

export default InlineRolePicker;
