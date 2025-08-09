import { createEffect } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useUser } from "./userProvider";

const AuthCallback = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const accessor = useUser();
    const [, actions] = accessor();

    createEffect(() => {
        const code = searchParams.code;
        if (code && actions && "login" in actions) {
            actions.login(code).then(() => {
                navigate("/");
            });
        }
    });

    return <div>Loading...</div>;
};

export default AuthCallback;
