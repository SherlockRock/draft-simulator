import { Component, Show, createEffect, createSignal } from "solid-js";
import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { Info } from "lucide-solid";
import toast from "solid-toast";
import { useUser } from "../userProvider";
import { AuthGuard } from "../components/AuthGuard";
import { DeleteAccountModal } from "../components/DeleteAccountModal";
import { exportUserData, deleteUserAccount, updateDisplayName } from "../utils/actions";

const SettingsPage: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user, actions] = context();
    const [isExporting, setIsExporting] = createSignal(false);
    const [showDeleteModal, setShowDeleteModal] = createSignal(false);
    const [showTooltip, setShowTooltip] = createSignal(false);
    const [displayName, setDisplayName] = createSignal("");
    const [isSaving, setIsSaving] = createSignal(false);
    const [nameError, setNameError] = createSignal("");

    createEffect(() => {
        const u = user();
        if (u) setDisplayName(u.display_name ?? "");
    });

    const handleSaveDisplayName = async () => {
        const value = displayName().trim();

        if (value === "") {
            setIsSaving(true);
            try {
                await updateDisplayName(null);
                actions.refetch();
                setNameError("");
                toast.success("Display name reset to Google name");
            } catch {
                toast.error("Failed to update display name");
            } finally {
                setIsSaving(false);
            }
            return;
        }

        if (value.length < 3 || value.length > 16) {
            setNameError("Must be 3-16 characters");
            return;
        }

        if (!/^[a-zA-Z0-9 _]{3,16}$/.test(value)) {
            setNameError("Only letters, numbers, spaces, and underscores");
            return;
        }

        setIsSaving(true);
        setNameError("");
        try {
            await updateDisplayName(value);
            actions.refetch();
            toast.success("Display name updated");
        } catch {
            toast.error("Failed to update display name");
        } finally {
            setIsSaving(false);
        }
    };

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const data = await exportUserData();
            const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json"
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
        await deleteUserAccount(confirmEmail);
        actions.logout();
        navigate("/", { replace: true });
    };

    return (
        <AuthGuard requireAuth>
            <Title>Settings - First Pick</Title>
            <div class="flex-1 overflow-auto bg-slate-900">
                <Show
                    when={user()}
                    fallback={
                        <div class="flex h-full items-center justify-center">
                            <p class="text-slate-400">Loading...</p>
                        </div>
                    }
                >
                    <div class="mx-auto max-w-2xl p-8">
                        <h1 class="mb-8 text-3xl font-bold text-slate-50">Settings</h1>

                        {/* Profile Section */}
                        <div class="mb-6 rounded-lg border border-slate-700 bg-slate-800 p-6">
                            <div class="mb-4 flex items-center justify-between">
                                <h2 class="text-xl font-semibold text-slate-200">
                                    Profile
                                </h2>
                                <div class="relative">
                                    <button
                                        class="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                                        onMouseEnter={() => setShowTooltip(true)}
                                        onMouseLeave={() => setShowTooltip(false)}
                                    >
                                        {/* TODO: DRA-40 - Review: was filled icon */}
                                        <Info size={20} />
                                    </button>
                                    <Show when={showTooltip()}>
                                        <div class="absolute right-0 top-8 z-10 w-64 rounded-lg border border-slate-600 bg-slate-700 p-3 text-sm text-slate-300 shadow-lg">
                                            <p class="mb-2 font-medium text-slate-200">
                                                Data from Google:
                                            </p>
                                            <ul class="mb-2 list-inside list-disc space-y-1">
                                                <li>Name</li>
                                                <li>Email address</li>
                                                <li>Profile picture</li>
                                            </ul>
                                            <p class="text-xs text-slate-400">
                                                We cannot access your Google Drive,
                                                contacts, or other Google services.
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
                                    <p class="text-lg font-medium text-slate-100">
                                        {user()?.name}
                                    </p>
                                    <p class="text-slate-400">{user()?.email}</p>
                                    <p class="mt-1 text-xs text-slate-500">
                                        Managed by Google
                                    </p>
                                </div>
                            </div>

                            {/* Divider */}
                            <div class="my-4 border-t border-slate-700" />

                            {/* Display Name */}
                            <div>
                                <label class="text-xs font-medium uppercase tracking-wide text-slate-400">
                                    Display Name
                                </label>
                                <div class="mt-1.5 flex gap-2">
                                    <input
                                        type="text"
                                        value={displayName()}
                                        onInput={(e) => {
                                            setDisplayName(e.currentTarget.value);
                                            setNameError("");
                                        }}
                                        placeholder="Enter display name..."
                                        maxLength={16}
                                        class="flex-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-teal-500 focus:outline-none"
                                    />
                                    <button
                                        onClick={handleSaveDisplayName}
                                        disabled={isSaving()}
                                        class="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isSaving() ? "Saving..." : "Save"}
                                    </button>
                                </div>
                                <Show when={nameError()}>
                                    <p class="mt-1 text-xs text-red-400">{nameError()}</p>
                                </Show>
                                <p class="mt-1.5 text-xs text-slate-500">
                                    3-16 characters. Letters, numbers, spaces, and
                                    underscores.
                                    {displayName()
                                        ? ""
                                        : " Leave empty to use your Google name."}
                                </p>
                            </div>
                        </div>

                        {/* Data Export Section */}
                        <div class="mb-6 rounded-lg border border-slate-700 bg-slate-800 p-6">
                            <h2 class="mb-2 text-xl font-semibold text-slate-200">
                                Your Data
                            </h2>
                            <p class="mb-4 text-slate-400">
                                Download a copy of all your data including canvases,
                                drafts, and versus series.
                            </p>
                            <button
                                onClick={handleExport}
                                disabled={isExporting()}
                                class="rounded-md bg-teal-700 px-4 py-2 font-medium text-slate-100 transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isExporting() ? "Exporting..." : "Export Data"}
                            </button>
                        </div>

                        {/* Delete Account */}
                        <div class="rounded-lg border-2 border-red-600/50 bg-slate-800 p-6">
                            <p class="mb-4 text-slate-400">
                                Delete your account and all associated data. This action
                                cannot be undone.
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
                </Show>
            </div>
        </AuthGuard>
    );
};

export default SettingsPage;
