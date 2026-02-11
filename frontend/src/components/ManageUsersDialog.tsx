import { Component, For, Show } from "solid-js";
import { CanvasUser } from "../utils/types";
import { UseQueryResult } from "@tanstack/solid-query";
import { StyledSelect } from "./StyledSelect";

interface ManageUsersDialogProps {
    usersQuery: UseQueryResult<CanvasUser[], Error>;
    onPermissionChange: (userId: string, permission: string) => void;
    onRemoveUser: (userId: string) => void;
    onClose: () => void;
}

export const ManageUsersDialog: Component<ManageUsersDialogProps> = (props) => {
    return (
        <div class="flex max-h-[80vh] w-[500px] flex-col overflow-hidden text-slate-200">
            <h2 class="mb-4 text-xl font-bold">Manage Users</h2>
            <div class="flex-1 space-y-3 overflow-y-auto pr-2">
                <Show when={props.usersQuery.isLoading}>
                    <div class="text-center text-slate-400">Loading users...</div>
                </Show>
                <Show when={props.usersQuery.isError}>
                    <div class="text-center text-red-400">Failed to load users</div>
                </Show>
                <For each={props.usersQuery.data}>
                    {(user) => (
                        <div class="flex items-center justify-between rounded bg-slate-800 p-2">
                            <div class="flex items-center gap-2">
                                {user.picture && (
                                    <img
                                        src={user.picture}
                                        class="h-8 w-8 rounded-full"
                                        alt={user.name}
                                    />
                                )}
                                <div>
                                    <div class="text-sm font-medium">{user.name}</div>
                                    <div class="text-xs text-slate-400">{user.email}</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <StyledSelect
                                    value={user.permissions}
                                    onChange={(val) =>
                                        props.onPermissionChange(user.id, val)
                                    }
                                    theme="purple"
                                    options={[
                                        { value: "view", label: "View" },
                                        { value: "edit", label: "Edit" },
                                        { value: "admin", label: "Admin" }
                                    ]}
                                    class="w-28"
                                />
                                <button
                                    onClick={() => props.onRemoveUser(user.id)}
                                    class="text-red-400 hover:text-red-300"
                                    title="Remove user"
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        class="h-5 w-5"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                    >
                                        <path
                                            fill-rule="evenodd"
                                            d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                                            clip-rule="evenodd"
                                        />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    )}
                </For>
                <Show when={props.usersQuery.data?.length === 0}>
                    <p class="text-center text-slate-400">No users found.</p>
                </Show>
            </div>
            <div class="mt-4 flex justify-end border-t border-slate-600 pt-4">
                <button
                    class="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                    onClick={props.onClose}
                >
                    Close
                </button>
            </div>
        </div>
    );
};
