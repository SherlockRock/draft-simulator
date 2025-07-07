import { useSearchParams, useNavigate } from "@solidjs/router";
import { createEffect } from "solid-js";
import { BASE_URL } from "./utils/actions";

const SharePage = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    createEffect(() => {
        const token = searchParams.token;
        if (token) {
            window.location.href = `${BASE_URL}/shares/verify-link?token=${token}`;
        } else {
            // Handle case where there is no token
            navigate("/");
        }
    });

    return <div>Verifying share link...</div>;
};

export default SharePage;
