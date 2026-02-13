import { Component, onMount, onCleanup } from "solid-js";
import { CanvasDraft } from "../utils/types";

type DraftContextMenuProps = {
    position: { x: number; y: number };
    draft: CanvasDraft;
    onView: () => void;
    onGoTo: () => void;
    onCopy: () => void;
    onDelete: () => void;
    onClose: () => void;
};

export const DraftContextMenu: Component<DraftContextMenuProps> = (props) => {
    let menuRef: HTMLDivElement | undefined;

    const handleClickOutside = (e: MouseEvent) => {
        if (menuRef && !menuRef.contains(e.target as Node)) {
            props.onClose();
        }
    };

    onMount(() => {
        // Delay adding listener to avoid immediate close from the right-click event
        setTimeout(() => {
            document.addEventListener("mousedown", handleClickOutside);
        }, 0);
    });

    onCleanup(() => {
        document.removeEventListener("mousedown", handleClickOutside);
    });

    return (
        <div
            ref={menuRef}
            class="draft-context-menu fixed z-50 rounded-md border border-slate-500 bg-slate-700 py-1 shadow-lg"
            style={{
                left: `${props.position.x}px`,
                top: `${props.position.y}px`
            }}
        >
            <button
                class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                onClick={() => {
                    props.onView();
                    props.onClose();
                }}
            >
                View
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                onClick={() => {
                    props.onGoTo();
                    props.onClose();
                }}
            >
                Go to
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                onClick={() => {
                    props.onCopy();
                    props.onClose();
                }}
            >
                Copy
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600"
                onClick={() => {
                    props.onDelete();
                    props.onClose();
                }}
            >
                Delete
            </button>
        </div>
    );
};
