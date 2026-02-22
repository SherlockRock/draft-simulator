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
        const codeStr = Array.isArray(code) ? code[0] : code;
        const stateStr = Array.isArray(state) ? state[0] : state;
        if (codeStr && stateStr && actions && "login" in actions) {
            actions.login(codeStr, stateStr).catch(() => {
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
