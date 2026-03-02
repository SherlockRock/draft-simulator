import { useSearchParams, useNavigate } from "@solidjs/router";
import { onMount, Show } from "solid-js";
import { useMutation } from "@tanstack/solid-query";
import { toast } from "solid-toast";
import { verifyShareCanvasLink } from "./utils/actions";

const ShareCanvasPage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const mutation = useMutation(() => ({
        mutationFn: verifyShareCanvasLink,
        onSuccess: (data) => {
            toast.success("Canvas Shared Successfully");
            navigate(`/canvas/${data.canvasId}`);
        },
        onError: (error: Error) => {
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
        <Show when={mutation.isPending}>
            <div>Verifying canvas share link...</div>
        </Show>
    );
};

export default ShareCanvasPage;
