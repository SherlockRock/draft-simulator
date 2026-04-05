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
    // IMPORTANT: Access user() BEFORE checking user.isLoading to establish
    // reactive tracking — isLoading is a non-reactive getter on a plain object,
    // so early-returning before user() would leave the effect with no dependencies.
    createEffect(() => {
        if (!props.requireAuth) return;
        const userData = user();
        if (user.isLoading) return;
        if (!userData || user.authExpired) {
            navigate(props.fallbackPath ?? "/", { replace: true });
        }
    });

    return (
        <Show
            when={!props.requireAuth || !user.isLoading}
            fallback={
                <div class="flex h-full w-full items-center justify-center bg-darius-card-hover">
                    <div class="align-center flex flex-col items-center">
                        <div class="h-12 w-12 animate-spin rounded-full border-4 border-darius-crimson border-t-transparent" />
                        <p class="pt-4 text-darius-text-primary">
                            Checking authentication...
                        </p>
                    </div>
                </div>
            }
        >
            <Show when={!props.requireAuth || (user() != null && !user.authExpired)}>
                {props.children}
            </Show>
        </Show>
    );
};
