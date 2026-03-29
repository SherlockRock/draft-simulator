import { Component, Show } from "solid-js";
import { X } from "lucide-solid";

interface WinnerDeclarationModalProps {
    isOpen: boolean;
    blueTeamName: string;
    redTeamName: string;
    onDeclareWinner: (winner: "blue" | "red" | null) => void;
    isSpectator: boolean;
    onClose?: () => void;
}

export const WinnerDeclarationModal: Component<WinnerDeclarationModalProps> = (props) => {
    return (
        <Show when={props.isOpen}>
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                <div class="relative w-full max-w-md rounded-lg border border-slate-700 bg-slate-800 p-8 pt-10">
                    <Show when={props.onClose}>
                        <button
                            type="button"
                            onClick={() => props.onClose?.()}
                            class="absolute right-4 top-4 text-slate-400 transition-colors hover:text-slate-200"
                            aria-label="Close dialog"
                        >
                            <X size={20} />
                        </button>
                    </Show>
                    <div class="mb-6 text-center">
                        <div class="mb-4 text-6xl">🏆</div>
                        <h2 class="mb-2 text-2xl font-bold text-slate-50">
                            Draft Complete!
                        </h2>
                        <p class="text-slate-400">
                            {props.isSpectator
                                ? "Waiting for captains to declare the winner..."
                                : "Who won this game?"}
                        </p>
                    </div>

                    <Show when={!props.isSpectator}>
                        <div class="space-y-3">
                            <button
                                onClick={() => props.onDeclareWinner("blue")}
                                class="w-full rounded-lg border-2 border-blue-600/50 bg-blue-600/10 p-4 font-semibold text-blue-400 transition-all hover:border-blue-500 hover:bg-blue-600/20"
                            >
                                {props.blueTeamName} Won
                            </button>

                            <button
                                onClick={() => props.onDeclareWinner("red")}
                                class="w-full rounded-lg border-2 border-red-600/50 bg-red-600/10 p-4 font-semibold text-red-400 transition-all hover:border-red-500 hover:bg-red-600/20"
                            >
                                {props.redTeamName} Won
                            </button>

                            <button
                                onClick={() => props.onDeclareWinner(null)}
                                class="w-full rounded-lg border-2 border-slate-600/50 bg-slate-600/10 p-4 font-semibold text-slate-400 transition-all hover:border-slate-500 hover:bg-slate-600/20"
                            >
                                Skip (No Winner)
                            </button>
                        </div>
                    </Show>
                </div>
            </div>
        </Show>
    );
};
