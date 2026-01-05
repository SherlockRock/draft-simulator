import { Component, Show } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { useUser } from "../userProvider";
import { handleLogin, handleRevoke } from "../utils/actions";

const GlobalNavBar: Component = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const accessor = useUser();
    const [user, actions] = accessor();

    const activeFlow = () => {
        const path = location.pathname;
        if (path.startsWith("/draft")) return "draft";
        if (path.startsWith("/canvas")) return "canvas";
        if (path.startsWith("/versus")) return "versus";
        return null;
    };

    const handleLogOut = () => {
        handleRevoke();
        if (actions && "logout" in actions) {
            actions.logout();
        }
    };

    return (
        <div class="global-navbar flex items-center justify-between border-b border-slate-700 bg-slate-900 px-6 py-3">
            {/* Flow Navigation */}
            <div class="flex gap-2">
                <button
                    onClick={() => navigate("/")}
                    class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                        activeFlow() === null
                            ? "bg-teal-700 text-slate-50"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                >
                    <span>🏠</span>
                    <span>Home</span>
                </button>
                <button
                    onClick={() => navigate("/draft")}
                    class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                        activeFlow() === "draft"
                            ? "bg-teal-700 text-slate-50"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                >
                    <span>📄</span>
                    <span>Draft</span>
                </button>
                <button
                    onClick={() => navigate("/canvas")}
                    class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                        activeFlow() === "canvas"
                            ? "bg-teal-700 text-slate-50"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                >
                    <span>🎨</span>
                    <span>Canvas</span>
                </button>
                <button
                    onClick={() => navigate("/versus")}
                    class={`flex items-center gap-2 rounded-md px-4 py-2 font-medium transition-colors ${
                        activeFlow() === "versus"
                            ? "bg-teal-700 text-slate-50"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                >
                    <span>⚔️</span>
                    <span>Versus</span>
                </button>
            </div>

            {/* User Section */}
            <div class="flex items-center gap-3">
                <Show when={user() && "name" in user()}>
                    <div class="flex items-center gap-3">
                        <Show when={user().picture}>
                            <img
                                src={user().picture}
                                alt={user().name}
                                class="h-8 w-8 rounded-full"
                            />
                        </Show>
                        <span class="font-medium text-slate-200">{user().name}</span>
                        <button
                            onClick={() => navigate("/settings")}
                            class="rounded-md bg-slate-800 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                        >
                            Settings
                        </button>
                        <button
                            onClick={handleLogOut}
                            class="rounded-md bg-slate-800 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                        >
                            Logout
                        </button>
                    </div>
                </Show>
                <Show when={!user() || !("name" in user())}>
                    <button
                        onClick={handleLogin}
                        class="rounded-md bg-teal-700 px-4 py-2 font-medium text-slate-100 transition-colors hover:bg-teal-600"
                    >
                        Login with Google
                    </button>
                </Show>
            </div>
        </div>
    );
};

export default GlobalNavBar;
