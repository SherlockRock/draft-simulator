import { useSearchParams, useNavigate } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";
import { Title, Meta } from "@solidjs/meta";
import { useMutation } from "@tanstack/solid-query";
import { toast } from "solid-toast";
import { Lock } from "lucide-solid";
import { verifyShareCanvasLink, handleLogin } from "./utils/actions";

const ShareCanvasPage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const [needsAuth, setNeedsAuth] = createSignal(false);

    const mutation = useMutation(() => ({
        mutationFn: verifyShareCanvasLink,
        onSuccess: (data) => {
            toast.success("Canvas Shared Successfully");
            navigate(`/canvas/${data.canvasId}`);
        },
        onError: (error: Error) => {
            if (error.message.includes("401")) {
                setNeedsAuth(true);
                return;
            }
            toast.error(`Share verification failed: ${error.message}`);
            navigate("/");
        }
    }));

    onMount(() => {
        const token = searchParams.token;
        if (typeof token === "string") {
            mutation.mutate(token);
        } else {
            navigate("/");
        }
    });

    return (
        <div class="flex h-full w-full flex-col items-center justify-center bg-slate-800">
            <Title>Shared Canvas - First Pick</Title>
            <Meta name="description" content="View a shared draft canvas." />
            <Show when={needsAuth()}>
                <div class="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-slate-700/50 ring-1 ring-slate-600/50">
                    <Lock size={28} class="text-slate-400" />
                </div>
                <h2 class="mb-2 text-lg font-medium text-slate-200">
                    Sign in to view this canvas
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-slate-400">
                    Someone shared a canvas with you. Sign in to access it.
                </p>
                <div class="flex flex-col gap-2">
                    <button
                        onClick={() => handleLogin()}
                        class="rounded-md bg-teal-700 px-5 py-2 text-sm font-medium text-slate-50 transition-colors hover:bg-teal-600"
                    >
                        Sign in with Google
                    </button>
                    <button
                        onClick={() => navigate("/")}
                        class="rounded-md px-5 py-2 text-sm text-slate-400 transition-colors hover:text-slate-200"
                    >
                        Go to homepage
                    </button>
                </div>
            </Show>
            <Show when={mutation.isPending}>
                <p class="text-sm text-slate-400">Verifying share link...</p>
            </Show>
        </div>
    );
};

export default ShareCanvasPage;
