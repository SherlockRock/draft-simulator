import { Component, Show } from "solid-js";
import { Lock, CircleHelp } from "lucide-solid";
import { handleLogin } from "../utils/actions";

export type AccessErrorType = "unauthorized" | "forbidden" | "notFound";

type CanvasAccessDeniedProps = {
    errorType: AccessErrorType;
    onNavigateToCanvases: () => void;
};

export const CanvasAccessDenied: Component<CanvasAccessDeniedProps> = (props) => {
    const handleSignIn = () => {
        // handleLogin automatically stores current URL as return destination
        handleLogin();
    };

    return (
        <div class="flex h-full w-full flex-col items-center justify-center bg-darius-card-hover">
            {/* Icon */}
            <div class="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-darius-card-hover/50 ring-1 ring-darius-border">
                <Show
                    when={props.errorType === "notFound"}
                    fallback={<Lock size={28} class="text-darius-text-secondary" />}
                >
                    <CircleHelp size={28} class="text-darius-text-secondary" />
                </Show>
            </div>

            {/* Message */}
            <Show when={props.errorType === "unauthorized"}>
                <h2 class="mb-2 text-lg font-medium text-darius-text-primary">
                    Sign in to view this canvas
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-darius-text-secondary">
                    You need to be signed in to access this canvas.
                </p>
            </Show>

            <Show when={props.errorType === "forbidden"}>
                <h2 class="mb-2 text-lg font-medium text-darius-text-primary">
                    You don't have access
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-darius-text-secondary">
                    This canvas is private. Ask the owner to share it with you.
                </p>
            </Show>

            <Show when={props.errorType === "notFound"}>
                <h2 class="mb-2 text-lg font-medium text-darius-text-primary">
                    Canvas not found
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-darius-text-secondary">
                    This canvas doesn't exist or may have been deleted.
                </p>
            </Show>

            {/* Actions */}
            <div class="flex flex-col gap-2">
                <Show when={props.errorType === "unauthorized"}>
                    <button
                        onClick={handleSignIn}
                        class="rounded-md bg-darius-purple bg-darius-purple px-5 py-2 text-sm font-medium text-darius-text-primary transition-colors"
                    >
                        Sign in
                    </button>
                    <button
                        onClick={props.onNavigateToCanvases}
                        class="rounded-md px-5 py-2 text-sm text-darius-text-primary text-darius-text-secondary transition-colors"
                    >
                        Continue without signing in
                    </button>
                </Show>

                <Show when={props.errorType !== "unauthorized"}>
                    <button
                        onClick={props.onNavigateToCanvases}
                        class="rounded-md bg-darius-purple bg-darius-purple px-5 py-2 text-sm font-medium text-darius-text-primary transition-colors"
                    >
                        View your canvases
                    </button>
                </Show>
            </div>
        </div>
    );
};
