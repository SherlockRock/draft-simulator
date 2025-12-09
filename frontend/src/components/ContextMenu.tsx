import { createEffect, For, onCleanup } from "solid-js";
import { ContextMenuAction, ContextMenuPosition } from "../utils/types";

type ContextMenuProps = {
    position: ContextMenuPosition;
    actions: ContextMenuAction[];
    onClose: () => void;
};

export const ContextMenu = (props: ContextMenuProps) => {
    // Click outside to close
    createEffect(() => {
        const handleClick = (e: MouseEvent) => {
            e.stopPropagation();
            props.onClose();
        };

        // Small delay to prevent immediate close from the same click that opened it
        setTimeout(() => {
            window.addEventListener("click", handleClick);
        }, 10);

        onCleanup(() => {
            window.removeEventListener("click", handleClick);
        });
    });

    // Close on Escape key
    createEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                props.onClose();
            }
        };

        window.addEventListener("keydown", handleKeyDown);

        onCleanup(() => {
            window.removeEventListener("keydown", handleKeyDown);
        });
    });

    return (
        <div
            class="fixed z-50 min-w-48 rounded border border-slate-500 bg-slate-700 py-1 shadow-lg"
            style={{
                left: `${props.position.x}px`,
                top: `${props.position.y}px`
            }}
            onClick={(e) => e.stopPropagation()}
        >
            <For each={props.actions}>
                {(action) => (
                    <button
                        class="w-full px-4 py-2 text-left text-slate-50 transition-colors hover:bg-slate-600"
                        classList={{
                            "text-red-400 hover:bg-red-900/20": action.destructive
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            action.action();
                        }}
                    >
                        {action.label}
                    </button>
                )}
            </For>
        </div>
    );
};
