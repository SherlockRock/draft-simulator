import { Accessor, Component, For, Show } from "solid-js";
import { Viewport } from "../utils/schemas";
import { PresenceUser, presenceColor, worldToScreen } from "../utils/presence";
import { RemoteCursor } from "../utils/remoteCursors";

// Figma-style remote cursors: colored arrow + name pill per present user,
// world→screen through the local viewport. The overflow-hidden container
// clips off-viewport cursors, so they simply don't show. Names come from the
// presence list — a cursor whose user is not (yet) present renders nothing.
//
// MUST be mounted `absolute inset-0` directly inside the same container
// whose bounding rect Canvas's screenToWorld subtracts (canvasContainerRef):
// worldToScreen omits that rect offset, so the two only cancel out when this
// overlay's origin coincides with the container's top-left corner.
export const CursorOverlay: Component<{
    cursors: RemoteCursor[];
    users: PresenceUser[];
    viewport: Accessor<Viewport>;
}> = (props) => {
    return (
        <div class="pointer-events-none absolute inset-0 z-40 overflow-hidden">
            <For each={props.cursors}>
                {(cursor) => {
                    const displayName = () =>
                        props.users.find((u) => u.userId === cursor.userId)?.displayName;
                    const screen = () =>
                        worldToScreen(cursor.x, cursor.y, props.viewport());
                    const color = presenceColor(cursor.userId);
                    return (
                        <Show when={displayName()}>
                            {(name) => (
                                <div
                                    class="absolute left-0 top-0"
                                    style={{
                                        transform: `translate(${screen().x}px, ${screen().y}px)`,
                                        transition:
                                            "transform 80ms linear, opacity 500ms ease",
                                        opacity: cursor.idle ? 0 : 1
                                    }}
                                >
                                    <svg
                                        width="18"
                                        height="18"
                                        viewBox="0 0 16 16"
                                        class="drop-shadow"
                                    >
                                        <path
                                            d="M 2 2 L 7.3 14 L 9.2 9.2 L 14 7.3 Z"
                                            fill={color}
                                            stroke="#1A1018"
                                            stroke-width="1"
                                            stroke-linejoin="round"
                                        />
                                    </svg>
                                    <div
                                        class="absolute left-4 top-4 max-w-40 truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-darius-bg shadow"
                                        style={{ "background-color": color }}
                                    >
                                        {name()}
                                    </div>
                                </div>
                            )}
                        </Show>
                    );
                }}
            </For>
        </div>
    );
};
