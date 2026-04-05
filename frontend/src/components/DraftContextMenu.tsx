import { Component, onMount, onCleanup, Show } from "solid-js";
import { CanvasDraft } from "../utils/schemas";

type DraftContextMenuProps = {
    position: { x: number; y: number };
    draft: CanvasDraft;
    onRename?: () => void;
    onView: () => void;
    onGoTo: () => void;
    onCopy: () => void;
    onDelete?: () => void;
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
            class="draft-context-menu fixed z-50 w-36 rounded-md border border-darius-border bg-darius-card-hover py-1 shadow-lg"
            style={{
                left: `${props.position.x}px`,
                top: `${props.position.y}px`
            }}
        >
            <div class="truncate border-b border-darius-border px-4 py-1.5 text-xs text-darius-text-secondary">
                {props.draft.Draft.name}
            </div>
            <Show when={props.onRename}>
                <button
                    class="w-full px-4 py-2 text-left text-sm text-darius-text-primary transition-colors hover:bg-darius-border"
                    onClick={() => {
                        props.onRename?.();
                        props.onClose();
                    }}
                >
                    Rename
                </button>
            </Show>
            <button
                class="w-full px-4 py-2 text-left text-sm text-darius-text-primary transition-colors hover:bg-darius-border"
                onClick={() => {
                    props.onView();
                    props.onClose();
                }}
            >
                View draft
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-darius-text-primary transition-colors hover:bg-darius-border"
                onClick={() => {
                    props.onGoTo();
                    props.onClose();
                }}
            >
                Go to
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-darius-text-primary transition-colors hover:bg-darius-border"
                onClick={() => {
                    props.onCopy();
                    props.onClose();
                }}
            >
                Copy
            </button>
            <Show when={props.onDelete}>
                <button
                    class="w-full px-4 py-2 text-left text-sm text-darius-crimson transition-colors hover:bg-darius-crimson/15"
                    onClick={() => {
                        props.onDelete?.();
                        props.onClose();
                    }}
                >
                    Delete
                </button>
            </Show>
        </div>
    );
};
