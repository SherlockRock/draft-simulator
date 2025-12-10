import { useSearchParams, useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import { toast } from "solid-toast";
import { BASE_URL } from "./utils/actions";

const ShareCanvasPage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    onMount(async () => {
        const token = searchParams.token;
        if (token) {
            try {
                const response = await fetch(
                    `${BASE_URL}/shares/verify-canvas-link?token=${token}`,
                    {
                        method: "GET",
                        credentials: "include"
                    }
                );

                if (response.ok) {
                    const data = await response.json();
                    toast.success("Canvas Shared Successfully");
                    navigate(`/canvas/${data.canvasId}`);
                } else {
                    const error = await response.json();
                    toast.error(`Share verification failed: ${error}`);
                    navigate("/");
                }
            } catch (error) {
                toast.error(`Share verification failed: ${error}`);
                navigate("/");
            }
        } else {
            navigate("/");
        }
    });

    return <div>Verifying canvas share link...</div>;
};

export default ShareCanvasPage;
