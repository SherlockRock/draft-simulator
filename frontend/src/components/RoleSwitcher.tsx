import { Component, createSignal, Show } from "solid-js";
import { ChevronDown, ArrowLeftRight } from "lucide-solid";
import { clearVersusRole } from "../utils/versusStorage";
import { useVersusContext } from "../contexts/VersusContext";
import toast from "solid-toast";

interface RoleSwitcherProps {
    versusDraftId: string;
    currentRole: "blue_captain" | "red_captain" | "spectator";
}

export const RoleSwitcher: Component<RoleSwitcherProps> = (props) => {
    const { releaseRole, versusContext } = useVersusContext();
    const [isOpen, setIsOpen] = createSignal(false);

    const handleSwitchRole = () => {
        clearVersusRole(props.versusDraftId);
        toast.success("Role released");
        setIsOpen(false);
        releaseRole();
    };

    const getRoleDisplay = () => {
        const vd = versusContext().versusDraft;
        if (props.currentRole === "blue_captain")
            return vd ? `${vd.blueTeamName} Captain` : "Captain";
        if (props.currentRole === "red_captain")
            return vd ? `${vd.redTeamName} Captain` : "Captain";
        return "Spectator";
    };

    const getRoleStyles = () => {
        if (props.currentRole === "blue_captain" || props.currentRole === "red_captain")
            return {
                pill: "bg-orange-500/20 text-orange-300 border-orange-500/40 hover:bg-orange-500/30",
                dot: "bg-orange-400",
                text: "text-orange-400"
            };
        return {
            pill: "bg-slate-600/30 text-slate-300 border-slate-500/40 hover:bg-slate-600/50",
            dot: "bg-slate-400",
            text: "text-slate-400"
        };
    };

    return (
        <div class="relative">
            <button
                onClick={() => setIsOpen(!isOpen())}
                class={`flex w-full items-center justify-between rounded border px-4 py-2 text-sm font-medium shadow-lg transition-colors ${getRoleStyles().pill}`}
            >
                <div class={`h-2 w-2 rounded-full ${getRoleStyles().dot}`} />
                <span>{getRoleDisplay()}</span>
                <ChevronDown
                    size={12}
                    class={`transition-transform ${isOpen() ? "rotate-180" : ""}`}
                />
            </button>

            <Show when={isOpen()}>
                <div class="absolute left-0 top-12 z-50 w-full overflow-hidden rounded-xl border border-slate-600/50 bg-slate-800 shadow-xl">
                    <div class="border-b border-slate-700/50 bg-slate-800/80 px-4 py-3">
                        <div class="text-xs font-semibold uppercase tracking-wider text-slate-500">
                            Your Role
                        </div>
                        <div class={`mt-1 text-lg font-bold ${getRoleStyles().text}`}>
                            {getRoleDisplay()}
                        </div>
                    </div>

                    <div class="p-3">
                        <button
                            onClick={handleSwitchRole}
                            class="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-600"
                        >
                            <ArrowLeftRight size={16} />
                            Switch Role
                        </button>

                        <p class="mt-2.5 text-center text-xs text-slate-500">
                            Release your current role to choose a new one
                        </p>
                    </div>
                </div>
            </Show>

            <Show when={isOpen()}>
                <div class="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            </Show>
        </div>
    );
};
