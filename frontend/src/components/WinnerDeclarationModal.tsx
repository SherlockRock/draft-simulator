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
                <div class="relative w-full max-w-md rounded-lg border border-darius-border bg-darius-card p-8 pt-10">
                    <Show when={props.onClose}>
                        <button
                            type="button"
                            onClick={() => props.onClose?.()}
                            class="absolute right-4 top-4 text-darius-text-primary text-darius-text-secondary transition-colors"
                            aria-label="Close dialog"
                        >
                            <X size={20} />
                        </button>
                    </Show>
                    <div class="mb-6 text-center">
                        <div class="mb-4 text-6xl">🏆</div>
                        <h2 class="mb-2 text-2xl font-bold text-darius-text-primary">
                            Draft Complete!
                        </h2>
                        <p class="text-darius-text-secondary">
                            {props.isSpectator
                                ? "Waiting for captains to declare the winner..."
                                : "Who won this game?"}
                        </p>
                    </div>

                    <Show when={!props.isSpectator}>
                        <div class="space-y-3">
                            <button
                                onClick={() => props.onDeclareWinner("blue")}
                                class="w-full rounded-lg border-2 border-darius-crimson/50 bg-darius-crimson/10 p-4 font-semibold text-darius-crimson transition-all hover:border-darius-crimson hover:bg-darius-crimson/20"
                            >
                                {props.blueTeamName} Won
                            </button>

                            <button
                                onClick={() => props.onDeclareWinner("red")}
                                class="w-full rounded-lg border-2 border-darius-purple-bright/50 bg-darius-purple-bright/10 p-4 font-semibold text-darius-purple-bright transition-all hover:border-darius-purple-bright hover:bg-darius-purple-bright/20"
                            >
                                {props.redTeamName} Won
                            </button>

                            <button
                                onClick={() => props.onDeclareWinner(null)}
                                class="w-full rounded-lg border-2 border-darius-border bg-darius-disabled/20 p-4 font-semibold text-darius-text-secondary transition-all hover:bg-darius-disabled/30"
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
