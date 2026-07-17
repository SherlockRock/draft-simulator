import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { AlertTriangle, Check, Copy, Trash2 } from "lucide-solid";
import { UseQueryResult } from "@tanstack/solid-query";
import { CanvasUser } from "../utils/schemas";
import { StyledSelect } from "./StyledSelect";
import { useCanvasSocket } from "../providers/CanvasSocketProvider";
import { presenceColor } from "../utils/presence";

// Unified Share popover content (design: canvas-live-presence slice 3).
// One surface, two anchors: the sidebar Share button and the top-right
// presence stack render this same content. Admins get share links plus
// permission controls; everyone else gets the read-only access list.
// Jump-to-viewport buttons land on the online rows in slice 4.
interface SharePopoverContentProps {
    isAdmin: boolean;
    usersQuery: UseQueryResult<CanvasUser[], Error>;
    viewShareLinkQuery: UseQueryResult<string, Error>;
    editShareLinkQuery: UseQueryResult<string, Error>;
    currentUserId: string | undefined;
    onPermissionChange: (userId: string, permission: string) => void;
    onRemoveUser: (userId: string) => void;
}

const ShareLinkRow: Component<{
    label: string;
    query: UseQueryResult<string, Error>;
    copied: boolean;
    onCopy: () => void;
}> = (props) => {
    return (
        <div>
            <p class="mb-0.5 text-xs font-medium text-darius-text-secondary">
                {props.label}
            </p>
            <Show
                when={!props.query.isPending}
                fallback={
                    <div class="text-xs text-darius-text-secondary">Loading...</div>
                }
            >
                <div class="flex items-center gap-2">
                    <div class="selection-purple h-[26px] w-0 flex-grow cursor-text select-all truncate rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-xs text-darius-text-primary">
                        {props.query.data || ""}
                    </div>
                    <button
                        onClick={props.onCopy}
                        class="shrink-0 cursor-pointer rounded-md bg-darius-purple p-1.5 text-darius-text-primary transition-colors hover:bg-darius-purple-bright disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!props.query.data}
                    >
                        <Show when={!props.copied} fallback={<Check size={14} />}>
                            <Copy size={14} />
                        </Show>
                    </button>
                </div>
            </Show>
        </div>
    );
};

const AccessAvatar: Component<{ user: CanvasUser; online: boolean }> = (props) => {
    const displayName = () => props.user.display_name ?? props.user.name;
    return (
        <div
            class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-darius-card"
            classList={{ "border-darius-border": !props.online }}
            style={
                props.online
                    ? { "border-color": presenceColor(props.user.id) }
                    : undefined
            }
        >
            <Show
                when={props.user.picture}
                fallback={
                    <span class="text-xs font-semibold text-darius-text-primary">
                        {displayName().charAt(0).toUpperCase()}
                    </span>
                }
            >
                <img
                    src={props.user.picture}
                    alt={displayName()}
                    class="h-full w-full object-cover"
                />
            </Show>
        </div>
    );
};

const PERMISSION_LABELS: Record<CanvasUser["permissions"], string> = {
    view: "View",
    edit: "Edit",
    admin: "Admin"
};

export const SharePopoverContent: Component<SharePopoverContentProps> = (props) => {
    const { presenceUsers } = useCanvasSocket();
    const [copied, setCopied] = createSignal("");
    const [userToRemove, setUserToRemove] = createSignal<string | null>(null);

    const onlineIds = createMemo(
        () => new Set(presenceUsers().map((presenceUser) => presenceUser.userId))
    );

    // Online users first (colored presence dot), then alphabetical.
    const sortedUsers = createMemo(() => {
        const users = props.usersQuery.data ?? [];
        const online = onlineIds();
        return [...users].sort((a, b) => {
            const aOnline = online.has(a.id);
            const bOnline = online.has(b.id);
            if (aOnline !== bOnline) return aOnline ? -1 : 1;
            return (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name);
        });
    });

    const copyLink = (kind: "view" | "edit", link: string | undefined) => {
        if (!link) return;
        navigator.clipboard.writeText(link);
        setCopied(kind);
        setTimeout(() => setCopied(""), 2000);
    };

    return (
        <div class="space-y-3">
            <Show when={props.isAdmin}>
                <div class="space-y-2">
                    <div class="text-[11px] font-semibold uppercase tracking-wider text-darius-text-secondary">
                        Share links
                    </div>
                    <ShareLinkRow
                        label="View Access"
                        query={props.viewShareLinkQuery}
                        copied={copied() === "view"}
                        onCopy={() => copyLink("view", props.viewShareLinkQuery.data)}
                    />
                    <ShareLinkRow
                        label="Edit Access"
                        query={props.editShareLinkQuery}
                        copied={copied() === "edit"}
                        onCopy={() => copyLink("edit", props.editShareLinkQuery.data)}
                    />
                </div>
            </Show>
            <div>
                <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-darius-text-secondary">
                    People with access
                    <Show when={props.usersQuery.data}>
                        {(users) => <> — {users().length}</>}
                    </Show>
                </div>
                <Show when={props.usersQuery.isLoading}>
                    <div class="py-2 text-center text-xs text-darius-text-secondary">
                        Loading users...
                    </div>
                </Show>
                <Show when={props.usersQuery.isError}>
                    <div class="py-2 text-center text-xs text-red-400">
                        Failed to load users
                    </div>
                </Show>
                <div class="custom-scrollbar max-h-72 space-y-0.5 overflow-y-auto">
                    <For each={sortedUsers()}>
                        {(user) => {
                            const online = () => onlineIds().has(user.id);
                            const isConfirming = () => userToRemove() === user.id;
                            const displayName = () => user.display_name ?? user.name;

                            return (
                                <div
                                    class="rounded-md px-1.5 py-1.5"
                                    classList={{
                                        "border border-darius-crimson/30 bg-darius-crimson/10":
                                            isConfirming()
                                    }}
                                >
                                    <Show
                                        when={!isConfirming()}
                                        fallback={
                                            <div class="flex items-center gap-2">
                                                <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/20">
                                                    <AlertTriangle
                                                        size={14}
                                                        class="text-red-400"
                                                    />
                                                </div>
                                                <span class="min-w-0 flex-1 truncate text-xs text-darius-text-primary">
                                                    Remove {displayName()}?
                                                </span>
                                                <button
                                                    onClick={() => setUserToRemove(null)}
                                                    class="rounded bg-darius-ember px-2 py-1 text-xs text-darius-text-primary transition-[filter] hover:brightness-110"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        props.onRemoveUser(user.id);
                                                        setUserToRemove(null);
                                                    }}
                                                    class="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-400"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        }
                                    >
                                        <div class="flex items-center gap-2">
                                            <AccessAvatar user={user} online={online()} />
                                            <div class="min-w-0 flex-1">
                                                <div class="flex items-center gap-1.5">
                                                    <span class="min-w-0 truncate text-sm text-darius-text-primary">
                                                        {displayName()}
                                                    </span>
                                                    <Show
                                                        when={
                                                            user.id ===
                                                            props.currentUserId
                                                        }
                                                    >
                                                        <span class="shrink-0 text-xs text-darius-text-secondary">
                                                            (you)
                                                        </span>
                                                    </Show>
                                                    <Show when={user.isOwner}>
                                                        <span class="shrink-0 rounded bg-darius-purple/20 px-1.5 py-0.5 text-[10px] text-darius-purple-bright">
                                                            Owner
                                                        </span>
                                                    </Show>
                                                    <Show when={online()}>
                                                        <span
                                                            class="h-1.5 w-1.5 shrink-0 rounded-full"
                                                            style={{
                                                                "background-color":
                                                                    presenceColor(user.id)
                                                            }}
                                                        />
                                                    </Show>
                                                </div>
                                            </div>
                                            {/* Right-side controls; jump button joins
                                                this cluster in slice 4. */}
                                            <Show
                                                when={props.isAdmin}
                                                fallback={
                                                    <span class="shrink-0 text-xs text-darius-text-secondary">
                                                        {
                                                            PERMISSION_LABELS[
                                                                user.permissions
                                                            ]
                                                        }
                                                    </span>
                                                }
                                            >
                                                <StyledSelect
                                                    value={user.permissions}
                                                    onChange={(val) =>
                                                        props.onPermissionChange(
                                                            user.id,
                                                            val
                                                        )
                                                    }
                                                    theme="purple"
                                                    options={[
                                                        { value: "view", label: "View" },
                                                        { value: "edit", label: "Edit" },
                                                        { value: "admin", label: "Admin" }
                                                    ]}
                                                    class="w-24"
                                                />
                                                <Show
                                                    when={!user.isOwner}
                                                    fallback={<div class="w-[18px]" />}
                                                >
                                                    <button
                                                        onClick={() =>
                                                            setUserToRemove(user.id)
                                                        }
                                                        class="shrink-0 text-red-400 hover:text-red-300"
                                                        title="Remove user"
                                                    >
                                                        <Trash2 size={18} />
                                                    </button>
                                                </Show>
                                            </Show>
                                        </div>
                                    </Show>
                                </div>
                            );
                        }}
                    </For>
                </div>
                <Show
                    when={
                        !props.usersQuery.isLoading &&
                        !props.usersQuery.isError &&
                        sortedUsers().length === 0
                    }
                >
                    <p class="py-2 text-center text-xs text-darius-text-secondary">
                        No users found.
                    </p>
                </Show>
            </div>
        </div>
    );
};
