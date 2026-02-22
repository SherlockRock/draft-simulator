import {
    Accessor,
    createContext,
    createMemo,
    useContext,
    JSX,
    createEffect,
    createSignal
} from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { fetchUserDetails, handleGoogleLogin, handleRevoke } from "./utils/actions";
import { useNavigate } from "@solidjs/router";
import { syncLocalCanvasToServer } from "./utils/syncLocalCanvas";
import toast from "solid-toast";

export type UserData = {
    id: string;
    name: string;
    email: string;
    picture: string;
};

export interface UserAccessor {
    (): UserData | null | undefined;
    isLoading: boolean;
    loading: boolean;
    isError: boolean;
    error: Error | null;
}

export interface UserActions {
    login: (code: string, state: string) => Promise<UserData | undefined>;
    logout: () => Promise<void>;
    refetch: () => void;
}

export type UserContextValue = [UserAccessor, UserActions];

const UserContext = createContext<Accessor<UserContextValue>>();

export function UserProvider(props: { children: JSX.Element }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const isOAuthCallback = () => window.location.pathname.includes("/oauth2callback");

    const userQuery = useQuery(() => {
        const enabled = !isOAuthCallback();

        return {
            queryKey: ["user"],
            queryFn: fetchUserDetails,
            enabled: enabled,
            staleTime: 1000 * 60 * 60 * 24, // 24 hours
            retry: false
        };
    });

    const login = async (code: string, state: string) => {
        const res = await handleGoogleLogin(code, state);
        userQuery.refetch();

        // Check for local canvas to sync
        try {
            const syncedCanvasId = await syncLocalCanvasToServer();
            if (syncedCanvasId) {
                toast.success("Your canvas has been saved to your account!");
                navigate(`/canvas/${syncedCanvasId}`, { replace: true });
                return res?.user;
            }
        } catch (error) {
            console.error("Failed to sync local canvas:", error);
            toast.error("Couldn't save your local canvas. It's still stored locally.");
        }

        navigate(res?.returnTo ?? "/", { replace: true });
        return res?.user;
    };

    const logout = async () => {
        await handleRevoke();
        queryClient.setQueryData(["user"], null);
    };

    // Create a compatibility wrapper that mimics the old createResource API
    const userAccessor: UserAccessor = Object.assign(() => userQuery.data, {
        get isLoading() {
            return userQuery.isLoading;
        },
        get loading() {
            return userQuery.isLoading;
        },
        get isError() {
            return userQuery.isError;
        },
        get error() {
            return userQuery.error;
        }
    });

    const holdUser = createMemo<UserContextValue>(() => [
        userAccessor,
        {
            login,
            logout,
            refetch: userQuery.refetch
        }
    ]);

    return (
        <UserContext.Provider value={holdUser}>
            <div class="h-full">{props.children}</div>
        </UserContext.Provider>
    );
}

export function useUser() {
    const context = useContext(UserContext);
    if (!context) {
        throw new Error("useUser must be used within a UserProvider");
    }
    return context;
}
