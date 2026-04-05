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
        <div class="flex h-full w-full flex-col items-center justify-center bg-darius-card">
            <Title>Shared Canvas - First Pick</Title>
            <Meta name="description" content="View a shared draft canvas." />
            <Show when={needsAuth()}>
                <div class="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-darius-card-hover/50 ring-1 ring-darius-border">
                    <Lock size={28} class="text-darius-text-secondary" />
                </div>
                <h2 class="mb-2 text-lg font-medium text-darius-text-primary">
                    Sign in to view this canvas
                </h2>
                <p class="mb-6 max-w-xs text-center text-sm text-darius-text-secondary">
                    Someone shared a canvas with you. Sign in to access it.
                </p>
                <div class="flex flex-col gap-2">
                    <button
                        onClick={() => handleLogin()}
                        class="rounded-md bg-darius-ember bg-darius-ember px-5 py-2 text-sm font-medium text-darius-text-primary transition-colors"
                    >
                        Sign in with Google
                    </button>
                    <button
                        onClick={() => navigate("/")}
                        class="rounded-md px-5 py-2 text-sm text-darius-text-primary text-darius-text-secondary transition-colors"
                    >
                        Go to homepage
                    </button>
                </div>
            </Show>
            <Show when={mutation.isPending}>
                <p class="text-sm text-darius-text-secondary">Verifying share link...</p>
            </Show>
        </div>
    );
};

export default ShareCanvasPage;
