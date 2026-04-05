import { Component, Show, createSignal } from "solid-js";
import { X } from "lucide-solid";

interface DeleteAccountModalProps {
    isOpen: boolean;
    userEmail: string;
    onClose: () => void;
    onConfirm: (email: string) => Promise<void>;
}

export const DeleteAccountModal: Component<DeleteAccountModalProps> = (props) => {
    const [confirmEmail, setConfirmEmail] = createSignal("");
    const [isDeleting, setIsDeleting] = createSignal(false);
    const [error, setError] = createSignal("");

    const emailMatches = () => confirmEmail() === props.userEmail;

    const handleConfirm = async () => {
        if (!emailMatches()) return;
        setIsDeleting(true);
        setError("");
        try {
            await props.onConfirm(confirmEmail());
        } catch {
            setError("Failed to delete account. Please try again.");
            setIsDeleting(false);
        }
    };

    const handleClose = () => {
        setConfirmEmail("");
        setError("");
        props.onClose();
    };

    return (
        <Show when={props.isOpen}>
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                <div class="w-full max-w-md rounded-lg border border-darius-border bg-darius-card p-6">
                    <div class="mb-4 flex items-center justify-between">
                        <h2 class="text-xl font-bold text-darius-text-primary">
                            Delete Account
                        </h2>
                        <button
                            onClick={handleClose}
                            class="text-darius-text-primary text-darius-text-secondary"
                        >
                            {/* TODO: DRA-40 - Review: was filled icon */}
                            <X size={20} />
                        </button>
                    </div>

                    <div class="mb-4 text-darius-text-secondary">
                        <p class="mb-3">This will permanently delete:</p>
                        <ul class="mb-3 list-inside list-disc space-y-1 text-darius-text-secondary">
                            <li>Your profile and account</li>
                            <li>All canvases you own</li>
                            <li>All drafts on those canvases</li>
                        </ul>
                        <p class="text-sm text-darius-text-secondary">
                            Versus series you created will remain but show "Deleted User"
                            as creator.
                        </p>
                        <p class="mt-3 text-sm text-darius-text-secondary">
                            To fully disconnect from Google, also{" "}
                            <a
                                href="https://myaccount.google.com/permissions"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="text-darius-ember text-darius-ember underline"
                            >
                                revoke access in your Google Account
                            </a>
                            .
                        </p>
                    </div>

                    <div class="mb-4">
                        <label class="mb-2 block text-sm text-darius-text-secondary">
                            Type your email to confirm:
                        </label>
                        <input
                            type="email"
                            value={confirmEmail()}
                            onInput={(e) => setConfirmEmail(e.currentTarget.value)}
                            placeholder={props.userEmail}
                            class="w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary placeholder-darius-text-secondary focus:border-red-500 focus:outline-none"
                        />
                    </div>

                    <Show when={error()}>
                        <p class="mb-4 text-sm text-red-400">{error()}</p>
                    </Show>

                    <div class="flex justify-end gap-3">
                        <button
                            onClick={handleClose}
                            class="rounded-md bg-darius-card-hover px-4 py-2 text-darius-text-secondary transition-colors hover:bg-darius-border"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={!emailMatches() || isDeleting()}
                            class="rounded-md bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isDeleting() ? "Deleting..." : "Delete Account"}
                        </button>
                    </div>
                </div>
            </div>
        </Show>
    );
};
