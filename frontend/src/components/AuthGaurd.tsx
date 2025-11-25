import { Show, JSX } from "solid-js";
import { useUser } from "../userProvider";

type AuthGuardProps = {
    children: JSX.Element;
    fallbackPath?: string;
    requireAuth?: boolean;
};

export const AuthGuard = (props: AuthGuardProps) => {
    const accessor = useUser();
    const userAccessor = accessor()[0];

    return (
        <Show
            when={props.requireAuth && userAccessor() !== undefined}
            fallback={
                <div class="flex h-full items-center justify-center bg-slate-800">
                    <div class="align-center flex flex-col items-center">
                        <div class="h-12 w-12 animate-spin rounded-full border-4 border-teal-400 border-t-transparent" />
                        <p class="pt-4 text-slate-200">Checking authentication...</p>
                    </div>
                </div>
            }
        >
            {props.children}
        </Show>
    );
};
