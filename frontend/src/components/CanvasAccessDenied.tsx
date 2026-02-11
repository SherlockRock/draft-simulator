import { Component, Show } from "solid-js";
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
        <div class="flex h-full w-full flex-col items-center justify-center bg-slate-700">
            {/* Icon */}
            <div class="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-slate-600/50 ring-1 ring-slate-500/50">
                <Show
                    when={props.errorType === "notFound"}
                    fallback={
                        <svg
                            class="h-7 w-7 text-slate-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="1.5"
                                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                            />
                        </svg>
                    }
                >
                    <svg
                        class="h-7 w-7 text-slate-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="1.5"
                            d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
                        />
                    </svg>
                </Show>
            </div>

            {/* Message */}
            <Show when={props.errorType === "unauthorized"}>
                <h2 class="mb-2 text-lg font-medium text-slate-200">
                    Sign in to view this canvas
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-slate-400">
                    You need to be signed in to access this canvas.
                </p>
            </Show>

            <Show when={props.errorType === "forbidden"}>
                <h2 class="mb-2 text-lg font-medium text-slate-200">
                    You don't have access
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-slate-400">
                    This canvas is private. Ask the owner to share it with you.
                </p>
            </Show>

            <Show when={props.errorType === "notFound"}>
                <h2 class="mb-2 text-lg font-medium text-slate-200">Canvas not found</h2>
                <p class="mb-6 max-w-xs text-center text-sm text-slate-400">
                    This canvas doesn't exist or may have been deleted.
                </p>
            </Show>

            {/* Actions */}
            <div class="flex flex-col gap-2">
                <Show when={props.errorType === "unauthorized"}>
                    <button
                        onClick={handleSignIn}
                        class="rounded-md bg-purple-600 px-5 py-2 text-sm font-medium text-slate-50 transition-colors hover:bg-purple-500"
                    >
                        Sign in
                    </button>
                    <button
                        onClick={props.onNavigateToCanvases}
                        class="rounded-md px-5 py-2 text-sm text-slate-400 transition-colors hover:text-slate-200"
                    >
                        Continue without signing in
                    </button>
                </Show>

                <Show when={props.errorType !== "unauthorized"}>
                    <button
                        onClick={props.onNavigateToCanvases}
                        class="rounded-md bg-purple-600 px-5 py-2 text-sm font-medium text-slate-50 transition-colors hover:bg-purple-500"
                    >
                        View your canvases
                    </button>
                </Show>
            </div>
        </div>
    );
};
