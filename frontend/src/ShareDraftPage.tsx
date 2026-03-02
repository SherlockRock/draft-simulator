import { useSearchParams, useNavigate } from "@solidjs/router";
import { onMount, Show } from "solid-js";
import { useMutation } from "@tanstack/solid-query";
import { toast } from "solid-toast";
import { verifyShareDraftLink } from "./utils/actions";

const ShareDraftPage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const mutation = useMutation(() => ({
        mutationFn: verifyShareDraftLink,
        onSuccess: (data) => {
            toast.success("Draft Shared Successfully");
            if (data.canvasId) {
                navigate(`/canvas/${data.canvasId}/draft/${data.draftId}`);
            } else {
                navigate("/");
            }
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
            <div>Verifying draft share link...</div>
        </Show>
    );
};

export default ShareDraftPage;
