import { useLocation, useNavigate } from "@solidjs/router";
import { handleGoogleLogin } from "../utils/actions";
import { useUser } from "../userProvider";
import { onMount } from "solid-js";

function AuthCallback() {
    const location = useLocation();
    const navigate = useNavigate();
    const accessor = useUser();
    const { mutate } = accessor()[1];

    onMount(async () => {
        const code = new URLSearchParams(location.search).get("code");
        if (code) {
            const user = await handleGoogleLogin(code);
            if (user) {
                mutate(user);
                navigate("/", { replace: true });
            }
        }
    });

    return <div>Loading...</div>;
}

export default AuthCallback;
