import { Component, Show, createSignal } from "solid-js";

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
        } catch (e) {
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
                <div class="w-full max-w-md rounded-lg border border-slate-700 bg-slate-800 p-6">
                    <div class="mb-4 flex items-center justify-between">
                        <h2 class="text-xl font-bold text-slate-50">Delete Account</h2>
                        <button
                            onClick={handleClose}
                            class="text-slate-400 hover:text-slate-200"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                class="h-5 w-5"
                            >
                                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                        </button>
                    </div>

                    <div class="mb-4 text-slate-300">
                        <p class="mb-3">This will permanently delete:</p>
                        <ul class="mb-3 list-inside list-disc space-y-1 text-slate-400">
                            <li>Your profile and account</li>
                            <li>All canvases you own</li>
                            <li>All drafts on those canvases</li>
                        </ul>
                        <p class="text-sm text-slate-400">
                            Versus series you created will remain but show "Deleted User" as
                            creator.
                        </p>
                        <p class="mt-3 text-sm text-slate-400">
                            To fully disconnect from Google, also{" "}
                            <a
                                href="https://myaccount.google.com/permissions"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="text-teal-400 underline hover:text-teal-300"
                            >
                                revoke access in your Google Account
                            </a>
                            .
                        </p>
                    </div>

                    <div class="mb-4">
                        <label class="mb-2 block text-sm text-slate-300">
                            Type your email to confirm:
                        </label>
                        <input
                            type="email"
                            value={confirmEmail()}
                            onInput={(e) => setConfirmEmail(e.currentTarget.value)}
                            placeholder={props.userEmail}
                            class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-red-500 focus:outline-none"
                        />
                    </div>

                    <Show when={error()}>
                        <p class="mb-4 text-sm text-red-400">{error()}</p>
                    </Show>

                    <div class="flex justify-end gap-3">
                        <button
                            onClick={handleClose}
                            class="rounded-md bg-slate-700 px-4 py-2 text-slate-300 transition-colors hover:bg-slate-600"
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
