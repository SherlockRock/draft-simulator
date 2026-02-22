import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useUser } from "../userProvider";
import { DeleteAccountModal } from "../components/DeleteAccountModal";

const SettingsPage: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user, actions] = context();
    const [isExporting, setIsExporting] = createSignal(false);
    const [showDeleteModal, setShowDeleteModal] = createSignal(false);
    const [showTooltip, setShowTooltip] = createSignal(false);

    // Redirect if not logged in
    if (!user()) {
        navigate("/", { replace: true });
        return null;
    }

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const response = await fetch(
                `${import.meta.env.VITE_API_URL || ""}/api/users/me/export`,
                { credentials: "include" }
            );
            if (!response.ok) throw new Error("Export failed");

            const data = await response.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `draft-simulator-export-${new Date().toISOString().split("T")[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Export failed:", error);
        } finally {
            setIsExporting(false);
        }
    };

    const handleDeleteAccount = async (confirmEmail: string) => {
        try {
            const response = await fetch(
                `${import.meta.env.VITE_API_URL || ""}/api/users/me`,
                {
                    method: "DELETE",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ confirmEmail }),
                }
            );
            if (!response.ok) throw new Error("Delete failed");

            // Clear local state and redirect
            if (actions && "logout" in actions) {
                actions.logout();
            }
            navigate("/", { replace: true });
        } catch (error) {
            console.error("Delete failed:", error);
            throw error;
        }
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-2xl p-8">
                    <h1 class="mb-8 text-3xl font-bold text-slate-50">Settings</h1>

                    {/* Profile Section */}
                    <div class="mb-6 rounded-lg border border-slate-700 bg-slate-800 p-6">
                        <div class="mb-4 flex items-center justify-between">
                            <h2 class="text-xl font-semibold text-slate-200">Profile</h2>
                            <div class="relative">
                                <button
                                    class="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                                    onMouseEnter={() => setShowTooltip(true)}
                                    onMouseLeave={() => setShowTooltip(false)}
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                        class="h-5 w-5"
                                    >
                                        <path
                                            fill-rule="evenodd"
                                            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
                                            clip-rule="evenodd"
                                        />
                                    </svg>
                                </button>
                                <Show when={showTooltip()}>
                                    <div class="absolute right-0 top-8 z-10 w-64 rounded-lg border border-slate-600 bg-slate-700 p-3 text-sm text-slate-300 shadow-lg">
                                        <p class="mb-2 font-medium text-slate-200">
                                            Data from Google:
                                        </p>
                                        <ul class="mb-2 list-inside list-disc space-y-1">
                                            <li>Display name</li>
                                            <li>Email address</li>
                                            <li>Profile picture</li>
                                        </ul>
                                        <p class="text-xs text-slate-400">
                                            We cannot access your Google Drive, contacts, or other
                                            Google services.
                                        </p>
                                    </div>
                                </Show>
                            </div>
                        </div>
                        <div class="flex items-center gap-4">
                            <Show when={user()?.picture}>
                                <img
                                    src={user()?.picture}
                                    alt={user()?.name}
                                    class="h-16 w-16 rounded-full"
                                />
                            </Show>
                            <div>
                                <p class="text-lg font-medium text-slate-100">{user()?.name}</p>
                                <p class="text-slate-400">{user()?.email}</p>
                                <p class="mt-1 text-xs text-slate-500">Managed by Google</p>
                            </div>
                        </div>
                    </div>

                    {/* Data Export Section */}
                    <div class="mb-6 rounded-lg border border-slate-700 bg-slate-800 p-6">
                        <h2 class="mb-2 text-xl font-semibold text-slate-200">Your Data</h2>
                        <p class="mb-4 text-slate-400">
                            Download a copy of all your data including canvases, drafts, and
                            versus series.
                        </p>
                        <button
                            onClick={handleExport}
                            disabled={isExporting()}
                            class="rounded-md bg-teal-700 px-4 py-2 font-medium text-slate-100 transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isExporting() ? "Exporting..." : "Export Data"}
                        </button>
                    </div>

                    {/* Danger Zone */}
                    <div class="rounded-lg border-2 border-red-600/50 bg-slate-800 p-6">
                        <h2 class="mb-2 text-xl font-semibold text-red-400">Danger Zone</h2>
                        <p class="mb-4 text-slate-400">
                            Delete your account and all associated data. This action cannot be
                            undone.
                        </p>
                        <button
                            onClick={() => setShowDeleteModal(true)}
                            class="rounded-md bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-500"
                        >
                            Delete Account
                        </button>
                    </div>
            </div>

            <DeleteAccountModal
                isOpen={showDeleteModal()}
                userEmail={user()?.email ?? ""}
                onClose={() => setShowDeleteModal(false)}
                onConfirm={handleDeleteAccount}
            />
        </div>
    );
};

export default SettingsPage;
