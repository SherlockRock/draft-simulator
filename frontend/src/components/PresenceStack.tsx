import {
    Component,
    For,
    Show,
    createSignal,
    createEffect,
    createMemo,
    onCleanup,
    type JSX
} from "solid-js";
import { useUser } from "../userProvider";
import { PresenceUser, presenceColor } from "../utils/presence";

const MAX_STACK_AVATARS = 4;

const PresenceAvatar: Component<{
    user: PresenceUser;
    sizeClass: string;
}> = (props) => {
    return (
        <div
            class={`flex ${props.sizeClass} items-center justify-center overflow-hidden rounded-full border-2 bg-darius-card`}
            style={{ "border-color": presenceColor(props.user.userId) }}
            title={props.user.displayName}
        >
            <Show
                when={props.user.picture}
                fallback={
                    <span class="text-xs font-semibold text-darius-text-primary">
                        {props.user.displayName.charAt(0).toUpperCase()}
                    </span>
                }
            >
                <img
                    src={props.user.picture ?? undefined}
                    alt={props.user.displayName}
                    class="h-full w-full object-cover"
                />
            </Show>
        </div>
    );
};

// Top-right presence surface: overlapping avatars + count. When the unified
// Share popover plumbing is provided, the stack is its second anchor (same
// workflow-owned content as the sidebar Share button); otherwise it falls
// back to the legacy read-only viewer list.
export const PresenceStack: Component<{
    users: PresenceUser[];
    isShareOpen?: boolean;
    onOpenShare?: () => void;
    onCloseShare?: () => void;
    shareContent?: JSX.Element;
}> = (props) => {
    const accessor = useUser();
    const [user] = accessor();

    const [internalOpen, setInternalOpen] = createSignal(false);
    let buttonRef: HTMLButtonElement | undefined;
    let popoverRef: HTMLDivElement | undefined;

    // Controlled by the workflow's share-anchor state when both handlers
    // exist; uncontrolled (legacy viewer list) otherwise.
    const isControlled = () => !!(props.onOpenShare && props.onCloseShare);
    const isOpen = () => (isControlled() ? (props.isShareOpen ?? false) : internalOpen());

    const toggleOpen = () => {
        if (isControlled()) {
            if (isOpen()) {
                props.onCloseShare?.();
            } else {
                props.onOpenShare?.();
            }
        } else {
            setInternalOpen((open) => !open);
        }
    };

    const close = () => {
        if (isControlled()) {
            props.onCloseShare?.();
        } else {
            setInternalOpen(false);
        }
    };

    const currentUserId = () => user()?.id;

    // Self first, then alphabetical, so your own avatar never hides in the
    // overflow chip.
    const sortedUsers = createMemo(() => {
        const self = currentUserId();
        return [...props.users].sort((a, b) => {
            if (a.userId === self) return -1;
            if (b.userId === self) return 1;
            return a.displayName.localeCompare(b.displayName);
        });
    });

    const overflowCount = () => Math.max(0, sortedUsers().length - MAX_STACK_AVATARS);

    createEffect(() => {
        if (!isOpen()) return;

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;

            if (buttonRef?.contains(target) || popoverRef?.contains(target)) {
                return;
            }

            close();
        };

        document.addEventListener("mousedown", handlePointerDown);
        onCleanup(() => document.removeEventListener("mousedown", handlePointerDown));
    });

    return (
        <Show when={sortedUsers().length > 0}>
            <div class="absolute right-4 top-4 z-40">
                <button
                    ref={buttonRef}
                    type="button"
                    onClick={toggleOpen}
                    aria-label={`${sortedUsers().length} viewing this canvas`}
                    class="flex cursor-pointer items-center gap-2 rounded-full border border-darius-border bg-darius-card/90 py-1 pl-1 pr-3 shadow-lg backdrop-blur-sm transition-colors hover:border-darius-purple-bright/40"
                >
                    <div class="flex -space-x-2">
                        <For each={sortedUsers().slice(0, MAX_STACK_AVATARS)}>
                            {(presenceUser) => (
                                <PresenceAvatar user={presenceUser} sizeClass="h-7 w-7" />
                            )}
                        </For>
                    </div>
                    <span class="text-xs font-medium text-darius-text-secondary">
                        <Show when={overflowCount() > 0} fallback={sortedUsers().length}>
                            +{overflowCount()}
                        </Show>
                    </span>
                </button>
                <Show when={isOpen()}>
                    <div
                        ref={popoverRef}
                        class="absolute right-0 top-full mt-2 rounded-xl border border-darius-border bg-darius-bg shadow-xl"
                        classList={{
                            "w-80 p-3": isControlled(),
                            "w-64 p-2": !isControlled()
                        }}
                    >
                        <Show when={isControlled()}>{props.shareContent}</Show>
                        <Show when={!isControlled()}>
                            <LegacyViewerList
                                users={sortedUsers()}
                                currentUserId={currentUserId()}
                            />
                        </Show>
                    </div>
                </Show>
            </div>
        </Show>
    );
};

const LegacyViewerList: Component<{
    users: PresenceUser[];
    currentUserId: string | undefined;
}> = (props) => {
    return (
        <>
            <div class="mb-1 px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-darius-text-secondary">
                Viewing now — {props.users.length}
            </div>
            <div class="custom-scrollbar max-h-64 space-y-0.5 overflow-y-auto">
                <For each={props.users}>
                    {(presenceUser) => (
                        <div class="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                            <PresenceAvatar
                                user={presenceUser}
                                sizeClass="h-6 w-6 shrink-0"
                            />
                            <span class="min-w-0 truncate text-sm text-darius-text-primary">
                                {presenceUser.displayName}
                            </span>
                            <Show when={presenceUser.userId === props.currentUserId}>
                                <span class="text-xs text-darius-text-secondary">
                                    (you)
                                </span>
                            </Show>
                            <span
                                class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                    "background-color": presenceColor(presenceUser.userId)
                                }}
                            />
                        </div>
                    )}
                </For>
            </div>
        </>
    );
};
