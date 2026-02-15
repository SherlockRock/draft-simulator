import { Component, onMount, onCleanup, Show } from "solid-js";
import { CanvasGroup } from "../utils/schemas";

type GroupContextMenuProps = {
    position: { x: number; y: number };
    group: CanvasGroup;
    onRename?: () => void;
    onViewSeries?: () => void;
    onGoTo: () => void;
    onDelete: () => void;
    onClose: () => void;
};

export const GroupContextMenu: Component<GroupContextMenuProps> = (props) => {
    let menuRef: HTMLDivElement | undefined;

    const handleClickOutside = (e: MouseEvent) => {
        if (menuRef && !menuRef.contains(e.target as Node)) {
            props.onClose();
        }
    };

    onMount(() => {
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
            class="group-context-menu fixed z-50 w-36 rounded-md border border-slate-500 bg-slate-700 py-1 shadow-lg"
            style={{
                left: `${props.position.x}px`,
                top: `${props.position.y}px`
            }}
        >
            <div class="truncate border-b border-slate-600 px-4 py-1.5 text-xs text-slate-400">
                {props.group.name}
            </div>
            <Show
                when={props.group.type === "custom"}
                fallback={
                    <button
                        class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                        onClick={() => {
                            props.onViewSeries?.();
                            props.onClose();
                        }}
                    >
                        View series
                    </button>
                }
            >
                <button
                    class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                    onClick={() => {
                        props.onRename?.();
                        props.onClose();
                    }}
                >
                    Rename
                </button>
            </Show>
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
