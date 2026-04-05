import { Component, Show, createEffect, createSignal } from "solid-js";
import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { Info } from "lucide-solid";
import toast from "solid-toast";
import { useQueryClient } from "@tanstack/solid-query";
import { useUser, type UserData } from "../userProvider";
import { AuthGuard } from "../components/AuthGuard";
import { DeleteAccountModal } from "../components/DeleteAccountModal";
import {
    exportUserData,
    deleteUserAccount,
    updateDisplayName,
    updatePreferences
} from "../utils/actions";

const SettingsPage: Component = () => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
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
            <div class="flex-1 overflow-auto bg-darius-bg">
                <Show
                    when={user()}
                    fallback={
                        <div class="flex h-full items-center justify-center">
                            <p class="text-darius-text-secondary">Loading...</p>
                        </div>
                    }
                >
                    <div class="mx-auto max-w-2xl p-8">
                        <h1 class="mb-8 text-3xl font-bold text-darius-text-primary">
                            Settings
                        </h1>

                        {/* Profile Section */}
                        <div class="mb-6 rounded-lg border border-darius-border bg-darius-card p-6">
                            <div class="mb-4 flex items-center justify-between">
                                <h2 class="text-xl font-semibold text-darius-text-primary">
                                    Profile
                                </h2>
                                <div class="relative">
                                    <button
                                        class="flex h-6 w-6 items-center justify-center rounded-full bg-darius-card-hover text-darius-text-primary text-darius-text-secondary"
                                        onMouseEnter={() => setShowTooltip(true)}
                                        onMouseLeave={() => setShowTooltip(false)}
                                    >
                                        {/* TODO: DRA-40 - Review: was filled icon */}
                                        <Info size={20} />
                                    </button>
                                    <Show when={showTooltip()}>
                                        <div class="absolute right-0 top-8 z-10 w-64 rounded-lg border border-darius-border bg-darius-card-hover p-3 text-sm text-darius-text-secondary shadow-lg">
                                            <p class="mb-2 font-medium text-darius-text-primary">
                                                Data from Google:
                                            </p>
                                            <ul class="mb-2 list-inside list-disc space-y-1">
                                                <li>Name</li>
                                                <li>Email address</li>
                                                <li>Profile picture</li>
                                            </ul>
                                            <p class="text-xs text-darius-text-secondary">
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
                                    <p class="text-lg font-medium text-darius-text-primary">
                                        {user()?.name}
                                    </p>
                                    <p class="text-darius-text-secondary">
                                        {user()?.email}
                                    </p>
                                    <p class="mt-1 text-xs text-darius-text-secondary">
                                        Managed by Google
                                    </p>
                                </div>
                            </div>

                            {/* Divider */}
                            <div class="my-4 border-t border-darius-border" />

                            {/* Display Name */}
                            <div>
                                <label class="text-xs font-medium uppercase tracking-wide text-darius-text-secondary">
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
                                        class="flex-1 rounded-md border border-darius-border bg-darius-bg px-3 py-2 text-sm text-darius-text-primary placeholder-darius-text-secondary focus:border-darius-ember focus:outline-none"
                                    />
                                    <button
                                        onClick={handleSaveDisplayName}
                                        disabled={isSaving()}
                                        class="rounded-md bg-darius-ember bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isSaving() ? "Saving..." : "Save"}
                                    </button>
                                </div>
                                <Show when={nameError()}>
                                    <p class="mt-1 text-xs text-red-400">{nameError()}</p>
                                </Show>
                                <p class="mt-1.5 text-xs text-darius-text-secondary">
                                    3-16 characters. Letters, numbers, spaces, and
                                    underscores.
                                    {displayName()
                                        ? ""
                                        : " Leave empty to use your Google name."}
                                </p>
                            </div>
                        </div>

                        {/* Preferences Section */}
                        <div class="mb-6 rounded-lg border border-darius-border bg-darius-card p-6">
                            <h2 class="mb-4 text-xl font-semibold text-darius-text-primary">
                                Preferences
                            </h2>
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="text-darius-text-primary">
                                        Keyboard controls
                                    </p>
                                    <p class="text-sm text-darius-text-secondary">
                                        Start typing to filter champions during versus
                                        drafts without clicking the search bar
                                    </p>
                                </div>
                                <button
                                    onClick={async () => {
                                        const newValue = !user()?.keyboard_controls;
                                        queryClient.setQueryData(
                                            ["user"],
                                            (prev: UserData | null | undefined) =>
                                                prev
                                                    ? {
                                                          ...prev,
                                                          keyboard_controls: newValue
                                                      }
                                                    : prev
                                        );
                                        try {
                                            await updatePreferences({
                                                keyboard_controls: newValue
                                            });
                                        } catch {
                                            queryClient.setQueryData(
                                                ["user"],
                                                (prev: UserData | null | undefined) =>
                                                    prev
                                                        ? {
                                                              ...prev,
                                                              keyboard_controls: !newValue
                                                          }
                                                        : prev
                                            );
                                        }
                                    }}
                                    class={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                                        user()?.keyboard_controls
                                            ? "bg-darius-ember"
                                            : "bg-darius-border"
                                    }`}
                                >
                                    <span
                                        class={`inline-block h-5 w-5 rounded-full bg-darius-text-primary shadow transition-transform duration-200 ${
                                            user()?.keyboard_controls
                                                ? "translate-x-5"
                                                : "translate-x-0"
                                        }`}
                                    />
                                </button>
                            </div>
                        </div>

                        {/* Data Export Section */}
                        <div class="mb-6 rounded-lg border border-darius-border bg-darius-card p-6">
                            <h2 class="mb-2 text-xl font-semibold text-darius-text-primary">
                                Your Data
                            </h2>
                            <p class="mb-4 text-darius-text-secondary">
                                Download a copy of all your data including canvases,
                                drafts, and versus series.
                            </p>
                            <button
                                onClick={handleExport}
                                disabled={isExporting()}
                                class="rounded-md bg-darius-ember bg-darius-ember px-4 py-2 font-medium text-darius-text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isExporting() ? "Exporting..." : "Export Data"}
                            </button>
                        </div>

                        {/* Delete Account */}
                        <div class="rounded-lg border-2 border-red-600/50 bg-darius-card p-6">
                            <p class="mb-4 text-darius-text-secondary">
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
