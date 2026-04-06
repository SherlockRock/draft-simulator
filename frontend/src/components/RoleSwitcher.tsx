import { Component, createSignal, Show } from "solid-js";
import { ChevronDown, ArrowLeftRight } from "lucide-solid";
import { clearVersusRole } from "../utils/versusStorage";
import { useVersusContext } from "../contexts/VersusContext";
import toast from "solid-toast";

interface RoleSwitcherProps {
    currentRole: "team1_captain" | "team2_captain" | "spectator";
    canSwitchRoles?: boolean;
    disabledMessage?: string;
}

export const RoleSwitcher: Component<RoleSwitcherProps> = (props) => {
    const { releaseRole, versusContext } = useVersusContext();
    const [isOpen, setIsOpen] = createSignal(false);
    const canSwitchRoles = () => props.canSwitchRoles ?? true;

    const handleSwitchRole = () => {
        if (!canSwitchRoles()) return;

        const vd = versusContext().versusDraft;
        if (!vd) return;

        clearVersusRole(vd.id);
        toast.success("Role released");
        setIsOpen(false);
        releaseRole();
    };

    const getRoleDisplay = () => {
        const vd = versusContext().versusDraft;
        if (props.currentRole === "team1_captain")
            return vd ? `${vd.blueTeamName} Captain` : "Captain";
        if (props.currentRole === "team2_captain")
            return vd ? `${vd.redTeamName} Captain` : "Captain";
        return "Spectator";
    };

    const getRoleStyles = () => {
        if (
            props.currentRole === "team1_captain" ||
            props.currentRole === "team2_captain"
        )
            return {
                pill: "bg-darius-crimson/20 text-darius-crimson border-darius-crimson/60 hover:bg-darius-crimson/30",
                dot: "bg-darius-crimson",
                text: "text-darius-crimson"
            };
        return {
            pill: "bg-darius-disabled/30 text-darius-text-secondary border-darius-crimson/60 hover:bg-darius-disabled/50",
            dot: "bg-darius-disabled",
            text: "text-darius-text-secondary"
        };
    };

    return (
        <div class="relative">
            <button
                onClick={() => {
                    if (canSwitchRoles()) {
                        setIsOpen(!isOpen());
                    }
                }}
                disabled={!canSwitchRoles()}
                class={`flex w-full items-center justify-between rounded border px-4 py-2 text-sm font-medium shadow-lg transition-colors ${getRoleStyles().pill} ${
                    canSwitchRoles() ? "" : "cursor-not-allowed opacity-70"
                }`}
            >
                <div class={`h-2 w-2 rounded-full ${getRoleStyles().dot}`} />
                <span>{getRoleDisplay()}</span>
                <ChevronDown
                    size={12}
                    class={`transition-transform ${canSwitchRoles() && isOpen() ? "rotate-180" : ""}`}
                />
            </button>

            <Show when={!canSwitchRoles() && props.disabledMessage}>
                <p class="mt-2 text-center text-xs text-darius-text-secondary">
                    {props.disabledMessage}
                </p>
            </Show>

            <Show when={isOpen() && canSwitchRoles()}>
                <div class="absolute left-0 top-12 z-50 w-full overflow-hidden rounded-xl border border-darius-crimson/60 bg-darius-card shadow-xl">
                    <div class="border-b border-darius-border/50 bg-darius-card/80 px-4 py-3">
                        <div class="text-xs font-semibold uppercase tracking-wider text-darius-text-secondary">
                            Your Role
                        </div>
                        <div class={`mt-1 text-lg font-bold ${getRoleStyles().text}`}>
                            {getRoleDisplay()}
                        </div>
                    </div>

                    <div class="p-3">
                        <button
                            onClick={handleSwitchRole}
                            class="flex w-full items-center justify-center gap-2 rounded-lg border border-darius-crimson/60 bg-darius-card-hover px-4 py-2.5 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-disabled"
                        >
                            <ArrowLeftRight size={16} />
                            Switch Role
                        </button>

                        <p class="mt-2.5 text-center text-xs text-darius-text-secondary">
                            Release your current role to choose a new one
                        </p>
                    </div>
                </div>
            </Show>

            <Show when={isOpen() && canSwitchRoles()}>
                <div class="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            </Show>
        </div>
    );
};
