import { createSignal } from "solid-js";

type GroupNameDialogProps = {
    onConfirm: (name: string) => void;
    onCancel: () => void;
};

export const GroupNameDialog = (props: GroupNameDialogProps) => {
    const [name, setName] = createSignal("");

    const handleSubmit = (e: Event) => {
        e.preventDefault();
        const trimmedName = name().trim();
        if (trimmedName) {
            props.onConfirm(trimmedName);
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            props.onCancel();
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <h3 class="mb-4 text-lg font-bold text-slate-50">Create Group</h3>
            <div class="mb-4">
                <label class="block text-sm font-medium text-slate-300 mb-2">
                    Group Name
                </label>
                <input
                    type="text"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    class="w-full rounded-md border border-slate-500 bg-slate-700 px-3 py-2 text-slate-50 focus:border-teal-400 focus:outline-none"
                    placeholder="Enter group name"
                    autofocus
                    maxLength={100}
                />
            </div>
            <div class="flex justify-end gap-3">
                <button
                    type="button"
                    onClick={props.onCancel}
                    class="rounded-md bg-slate-600 px-4 py-2 text-slate-200 hover:bg-slate-500"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={!name().trim()}
                    class="rounded-md bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Create
                </button>
            </div>
        </form>
    );
};
