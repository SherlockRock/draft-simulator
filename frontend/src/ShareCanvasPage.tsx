import { useSearchParams, useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import { BASE_URL } from "./utils/actions";

const ShareCanvasPage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    onMount(async () => {
        const token = searchParams.token;
        if (token) {
            try {
                // Make an API request with credentials to verify the share
                const response = await fetch(
                    `${BASE_URL}/shares/verify-canvas-link?token=${token}`,
                    {
                        method: "GET",
                        credentials: "include" // This sends cookies cross-origin
                    }
                );

                if (response.ok) {
                    const data = await response.json();
                    // Navigate to the canvas page
                    navigate(`/canvas/${data.canvasId}`);
                } else {
                    // Error response
                    const error = await response.json();
                    console.error("Canvas share verification failed:", error);
                    navigate("/");
                }
            } catch (error) {
                console.error("Error verifying canvas share:", error);
                navigate("/");
            }
        } else {
            navigate("/");
        }
    });

    return <div>Verifying canvas share link...</div>;
};

export default ShareCanvasPage;
