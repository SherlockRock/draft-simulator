import { X } from "lucide-solid";
import { JSX, Show } from "solid-js";

export const Dialog = (props: {
    body: JSX.Element;
    isOpen: () => boolean;
    onCancel: () => void;
}) => (
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
