import { For, Show, onCleanup, onMount } from "solid-js";
import { ContextMenuEntry, ContextMenuPosition } from "../utils/types";

type ContextMenuProps = {
    position: ContextMenuPosition;
    actions: ContextMenuEntry[];
    // Optional truncated title row (e.g. draft/group name).
    header?: string;
    // Extra classes on the menu root (surface tag like "draft-context-menu").
    class?: string;
    onClose: () => void;
};

export const ContextMenu = (props: ContextMenuProps) => {
    let menuRef: HTMLDivElement | undefined;

    // Close on mousedown outside the menu. Registration is deferred a tick so
    // the interaction that opened the menu can't close it in the same event:
    // native contextmenu fires during mousedown on Linux/X11, and menus opened
    // by the canvas right mouse-up dispatcher mount before any later mousedown.
    const handleMouseDown = (e: MouseEvent) => {
        if (menuRef && e.target instanceof Node && !menuRef.contains(e.target)) {
            props.onClose();
        }
    };

    onMount(() => {
        const timer = setTimeout(() => {
            document.addEventListener("mousedown", handleMouseDown);
        }, 0);
        onCleanup(() => {
            clearTimeout(timer);
            document.removeEventListener("mousedown", handleMouseDown);
        });
    });

    onMount(() => {
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
            ref={menuRef}
            class={`fixed z-50 w-max min-w-48 max-w-xs rounded-md border border-darius-border bg-darius-card-hover py-1 shadow-lg ${props.class ?? ""}`}
            style={{
                left: `${props.position.x}px`,
                top: `${props.position.y}px`
            }}
            onClick={(e) => e.stopPropagation()}
        >
            <Show when={props.header}>
                <div class="truncate border-b border-darius-border px-4 py-1.5 text-xs text-darius-text-secondary">
                    {props.header}
                </div>
            </Show>
            <For each={props.actions}>
                {(entry) => (
                    <Show
                        when={"render" in entry}
                        fallback={
                            <button
                                class="w-full px-4 py-2 text-left text-sm transition-colors"
                                classList={{
                                    "text-darius-text-primary hover:bg-darius-border":
                                        !("render" in entry) && !entry.destructive,
                                    "text-darius-crimson hover:bg-darius-crimson/15":
                                        !("render" in entry) && entry.destructive
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if ("render" in entry) return;
                                    entry.action();
                                    props.onClose();
                                }}
                            >
                                {"render" in entry ? "" : entry.label}
                            </button>
                        }
                    >
                        {"render" in entry ? entry.render(props.onClose) : null}
                    </Show>
                )}
            </For>
        </div>
    );
};
