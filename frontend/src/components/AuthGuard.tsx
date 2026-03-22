import { Show, createEffect, JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useUser } from "../userProvider";

type AuthGuardProps = {
    children: JSX.Element;
    fallbackPath?: string;
    requireAuth?: boolean;
};

export const AuthGuard = (props: AuthGuardProps) => {
    const navigate = useNavigate();
    const accessor = useUser();
    const [user] = accessor();

    // Redirect when auth is required but user is not logged in (after loading)
    createEffect(() => {
        if (!props.requireAuth) return;
        if (user.isLoading) return;
        if (!user() || user.authExpired) {
            navigate(props.fallbackPath ?? "/", { replace: true });
        }
    });

    // While loading, show spinner for auth-required routes
    // Once loaded, show children (redirect effect handles the rest)
    return (
        <Show
            when={!props.requireAuth || (!user.isLoading && user() != null)}
            fallback={
                <Show when={user.isLoading}>
                    <div class="flex h-full w-full items-center justify-center bg-slate-700">
                        <div class="align-center flex flex-col items-center">
                            <div class="h-12 w-12 animate-spin rounded-full border-4 border-teal-400 border-t-transparent" />
                            <p class="pt-4 text-slate-200">Checking authentication...</p>
                        </div>
                    </div>
                </Show>
            }
        >
            {props.children}
        </Show>
    );
};
