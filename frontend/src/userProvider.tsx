import { Accessor, createContext, createMemo, useContext, JSX } from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { fetchUserDetails, handleGoogleLogin, handleRevoke } from "./utils/actions";
import { useNavigate } from "@solidjs/router";
import { syncLocalCanvasToServer } from "./utils/syncLocalCanvas";
import { clearLocalCanvas } from "./utils/localCanvasStore";
import toast from "solid-toast";
import { identifyUser, resetUser, track } from "./utils/analytics";

type UserData = {
    id: string;
    name: string;
    email: string;
    picture: string;
};

interface UserAccessor {
    (): UserData | null | undefined;
    isLoading: boolean;
    loading: boolean;
    isError: boolean;
    error: Error | null;
}

interface UserActions {
    login: (code: string, state: string) => Promise<UserData | undefined>;
    logout: () => Promise<void>;
    refetch: () => void;
}

type UserContextValue = [UserAccessor, UserActions];

const UserContext = createContext<Accessor<UserContextValue>>();

export function UserProvider(props: { children: JSX.Element }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const isOAuthCallback = () => window.location.pathname.includes("/oauth2callback");

    const userQuery = useQuery(() => {
        const enabled = !isOAuthCallback();

        return {
            queryKey: ["user"],
            queryFn: async () => {
                const user = await fetchUserDetails();
                if (user) {
                    identifyUser(user.id, {
                        name: user.name,
                        email: user.email
                    });
                }
                return user;
            },
            enabled: enabled,
            staleTime: 1000 * 60 * 60 * 24, // 24 hours
            retry: false
        };
    });

    const login = async (code: string, state: string) => {
        const res = await handleGoogleLogin(code, state);
        // Read cache before refetch to distinguish signup vs returning login
        const hadPriorSession = queryClient.getQueryData(["user"]);
        userQuery.refetch();

        if (res?.user) {
            identifyUser(res.user.id, {
                name: res.user.name,
                email: res.user.email
            });
            track(hadPriorSession ? "user_logged_in" : "user_signed_up", {
                method: "google"
            });
        }

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

        // If returnTo is /canvas/local, redirect to /canvas instead
        // so CanvasEntryRedirect can fetch the user's actual canvases
        if (res?.returnTo === "/canvas/local") {
            // Clear the empty local canvas since user is now authenticated
            clearLocalCanvas();
            navigate("/canvas", { replace: true });
        } else {
            navigate(res?.returnTo ?? "/", { replace: true });
        }
        return res?.user;
    };

    const logout = async () => {
        track("user_logged_out");
        resetUser();
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
