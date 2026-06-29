import { CornerDownLeft, X } from "lucide-solid";
import { createEffect, JSX, onCleanup, Show } from "solid-js";

export const Dialog = (props: {
    body: JSX.Element;
    isOpen: () => boolean;
    onCancel: () => void;
    onConfirm?: () => void;
    confirmOnInput?: boolean;
    shouldConfirmOnTarget?: (target: EventTarget | null) => boolean;
}) => {
    createEffect(() => {
        if (!props.isOpen()) return;

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;

            if (e.key === "Escape") {
                e.preventDefault();
                props.onCancel();
                return;
            }

            if (e.key !== "Enter" || !props.onConfirm) return;

            const target = e.target;
            const isTextEntry =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                (target instanceof HTMLElement && target.isContentEditable);

            if (
                isTextEntry &&
                !props.confirmOnInput &&
                !props.shouldConfirmOnTarget?.(target)
            ) {
                return;
            }

            e.preventDefault();
            props.onConfirm();
        };

        window.addEventListener("keydown", onKeyDown);
        onCleanup(() => window.removeEventListener("keydown", onKeyDown));
    });

    return (
        <Show when={props.isOpen()}>
            <div
                class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
                onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    if (e.target === e.currentTarget) {
                        props.onCancel();
                    }
                }}
                onWheel={(e: WheelEvent) => e.stopPropagation()}
                onContextMenu={(e: MouseEvent) => {
                    e.stopPropagation();
                }}
            >
                <div
                    class="relative max-h-[90vh] overflow-y-auto rounded-lg bg-darius-card p-6 pr-14 shadow-lg"
                    onContextMenu={(e: MouseEvent) => {
                        e.stopPropagation();
                    }}
                >
                    <button
                        type="button"
                        onClick={props.onCancel}
                        class="absolute right-4 top-4 text-darius-text-primary text-darius-text-secondary transition-colors"
                        aria-label="Close dialog"
                    >
                        <X size={20} />
                    </button>
                    {props.body}
                </div>
            </div>
        </Show>
    );
};

export const ReturnKeyHint = () => (
    <kbd
        class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-darius-text-primary/30 bg-darius-text-primary/10 px-1 text-darius-text-primary/90"
        aria-label="Enter"
        title="Enter"
    >
        <CornerDownLeft size={10} strokeWidth={2.5} aria-hidden="true" />
    </kbd>
);

export const EscapeKeyHint = () => (
    <kbd
        class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-darius-text-primary/30 bg-darius-text-primary/10 px-1 text-[10px] font-semibold leading-none text-darius-text-primary/90"
        aria-label="Escape"
        title="Escape"
    >
        Esc
    </kbd>
);
