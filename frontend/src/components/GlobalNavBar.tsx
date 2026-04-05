import { Component, Show } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { Pickaxe, LayoutDashboard, Swords } from "lucide-solid";
import { useUser, getDisplayName } from "../userProvider";
import { handleLogin, handleRevoke } from "../utils/actions";

const GlobalNavBar: Component = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const accessor = useUser();
    const [user, actions] = accessor();

    const activeFlow = () => {
        const path = location.pathname;
        if (path.startsWith("/canvas")) return "canvas";
        if (path.startsWith("/versus")) return "versus";
        return null;
    };

    const handleLogOut = () => {
        handleRevoke();
        if (actions && "logout" in actions) {
            actions.logout();
        }

        // Context-dependent redirect after logout
        const path = location.pathname;
        if (path.startsWith("/canvas")) {
            // Go through CanvasEntryRedirect to ensure fresh local canvas is created
            navigate("/canvas", { replace: true });
        } else if (path.startsWith("/settings")) {
            navigate("/", { replace: true });
        }
        // Versus and other pages: stay on current URL
    };

    return (
        <div class="global-navbar flex items-center justify-between border-b border-darius-border bg-darius-card px-6 py-3">
            {/* Brand + Flow Navigation */}
            <div class="flex items-center gap-6">
                <span
                    onClick={() => navigate("/")}
                    class="cursor-pointer text-xl font-bold text-darius-text-primary"
                >
                    First Pick
                </span>
                <div class="flex gap-2">
                    <button
                        onClick={() => navigate("/")}
                        class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                            activeFlow() === null
                                ? "bg-darius-ember text-white"
                                : "bg-darius-card-hover text-darius-text-secondary hover:bg-darius-border"
                        }`}
                    >
                        <Pickaxe
                            size={18}
                            class={activeFlow() === null ? "" : "text-darius-ember"}
                        />
                        <span>Home</span>
                    </button>
                    <button
                        onClick={() => navigate("/canvas")}
                        class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                            activeFlow() === "canvas"
                                ? "bg-darius-purple text-white"
                                : "bg-darius-card-hover text-darius-text-secondary hover:bg-darius-border"
                        }`}
                    >
                        <LayoutDashboard
                            size={18}
                            class={
                                activeFlow() === "canvas"
                                    ? ""
                                    : "text-darius-purple-bright"
                            }
                        />
                        <span>Canvas</span>
                    </button>
                    <button
                        onClick={() => navigate("/versus")}
                        class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                            activeFlow() === "versus"
                                ? "bg-darius-crimson text-white"
                                : "bg-darius-card-hover text-darius-text-secondary hover:bg-darius-border"
                        }`}
                    >
                        <Swords
                            size={18}
                            class={activeFlow() === "versus" ? "" : "text-darius-crimson"}
                        />
                        <span>Versus</span>
                    </button>
                </div>
            </div>

            {/* User Section */}
            <div class="flex items-center gap-3">
                <Show when={getDisplayName(user())}>
                    <div class="flex items-center gap-3">
                        <Show when={user()?.picture}>
                            <img
                                src={user()?.picture}
                                alt={getDisplayName(user())}
                                class="h-8 w-8 rounded-full"
                            />
                        </Show>
                        <span class="font-medium text-darius-text-primary">
                            {getDisplayName(user())}
                        </span>
                        <button
                            onClick={() => navigate("/settings")}
                            class="rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-sm text-darius-text-secondary transition-colors hover:bg-darius-border"
                        >
                            Settings
                        </button>
                        <button
                            onClick={handleLogOut}
                            class="rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-sm text-darius-text-secondary transition-colors hover:bg-darius-border"
                        >
                            Logout
                        </button>
                    </div>
                </Show>
                <Show when={!getDisplayName(user())}>
                    <button
                        onClick={handleLogin}
                        class="rounded-md bg-darius-ember px-4 py-2 font-medium text-white transition-colors hover:opacity-90"
                    >
                        Login with Google
                    </button>
                </Show>
            </div>
        </div>
    );
};

export default GlobalNavBar;
