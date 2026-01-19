import { onMount } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useUser } from "./userProvider";
import { toast } from "solid-toast";

const AuthCallback = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const accessor = useUser();
    const [, actions] = accessor();

    onMount(() => {
        const code = searchParams.code;
        const state = searchParams.state;
        if (code && actions && "login" in actions) {
            actions.login(code, state).catch(() => {
                toast.error(`Failed to sign in`);
                navigate("/", { replace: true });
            });
        } else {
            navigate("/login", { replace: true });
        }
    });

    return <div>Loading...</div>;
};

export default AuthCallback;
