import { useSearchParams, useNavigate } from "@solidjs/router";
import { createEffect } from "solid-js";
import { BASE_URL } from "./utils/actions";

const ShareCanvasPage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    createEffect(() => {
        const token = searchParams.token;
        if (token) {
            window.location.href = `${BASE_URL}/shares/verify-canvas-link?token=${token}`;
        } else {
            navigate("/");
        }
    });

    return <div>Verifying canvas share link...</div>;
};

export default ShareCanvasPage;
