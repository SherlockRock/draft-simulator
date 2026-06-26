import { Component, For, Show } from "solid-js";
import { Title, Meta } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { Compass, Trash2 } from "lucide-solid";
import toast from "solid-toast";
import { createMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { EMPTY_TEAM_POOL } from "@draft-sim/shared-types";
import type { NavigatorSessionData } from "../contexts/NavigatorContext";
import {
    createNavigatorSession,
    deleteNavigatorSession,
    fetchNavigatorSessions
} from "../utils/navigatorApi";

const formatRelativeDate = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - date.getTime());
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
        return `${diffMins} min${diffMins !== 1 ? "s" : ""} ago`;
    }

    if (diffHours < 24) {
        return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
    }

    if (diffDays < 7) {
        return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
    }

    return date.toLocaleDateString();
};

const getGameCount = (session: NavigatorSessionData) =>
    session.NavigatorDrafts?.length ?? 0;

const NavigatorDashboard: Component = () => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const sessionsQuery = useQuery(() => ({
        queryKey: ["navigatorSessions"],
        queryFn: () => fetchNavigatorSessions()
    }));

    const createSessionMutation = createMutation(() => ({
        mutationFn: () =>
            createNavigatorSession({
                our_side: "blue",
                blue_pool: EMPTY_TEAM_POOL,
                red_pool: EMPTY_TEAM_POOL,
                draft_mode: "standard",
                series_length: 1,
                side_swap_mode: "auto"
            }),
        onSuccess: (session) => {
            queryClient.invalidateQueries({ queryKey: ["navigatorSessions"] });
            navigate(`/navigator/${session.id}`);
        },
        onError: () => {
            toast.error("Failed to create navigator session");
        }
    }));

    const deleteSessionMutation = createMutation(() => ({
        mutationFn: (sessionId: string) => deleteNavigatorSession(sessionId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["navigatorSessions"] });
            toast.success("Session deleted");
        },
        onError: () => {
            toast.error("Failed to delete session");
        }
    }));

    const handleCreateSession = () => {
        createSessionMutation.mutate();
    };

    const handleDeleteSession = (event: MouseEvent, sessionId: string) => {
        event.stopPropagation();

        if (window.confirm("Delete this navigator session?")) {
            deleteSessionMutation.mutate(sessionId);
        }
    };

    return (
        <div class="flex-1 overflow-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <Title>Navigator - First Pick</Title>
            <Meta
                name="description"
                content="Live draft analysis powered by minimax search."
            />
            <div class="mx-auto flex min-h-full max-w-7xl flex-col p-8">
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex items-center overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800">
                        <div class="absolute inset-y-0 left-0 w-1.5 bg-blue-500" />
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 to-transparent" />

                        <div class="relative flex flex-1 items-center gap-3 py-6 pl-8 pr-4">
                            <Compass size={28} class="text-blue-400" />
                            <div>
                                <h1 class="text-2xl font-bold text-slate-100">
                                    Navigator 🧭
                                </h1>
                                <p class="text-sm text-slate-400">
                                    Live draft analysis powered by minimax search
                                </p>
                            </div>
                        </div>

                        <div class="relative pr-8">
                            <button
                                type="button"
                                onClick={handleCreateSession}
                                disabled={createSessionMutation.isPending}
                                class="rounded-lg bg-blue-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                            >
                                {createSessionMutation.isPending
                                    ? "Creating..."
                                    : "New Session"}
                            </button>
                        </div>
                    </div>
                </div>

                <section class="flex flex-1 flex-col">
                    <h2 class="mb-5 text-xl font-semibold text-slate-100">Sessions</h2>

                    <Show
                        when={sessionsQuery.data}
                        fallback={
                            <div class="rounded-lg border border-slate-700/50 bg-slate-800 p-6 text-slate-400">
                                Loading sessions...
                            </div>
                        }
                    >
                        <Show
                            when={(sessionsQuery.data?.length ?? 0) > 0}
                            fallback={
                                <div class="rounded-lg border border-slate-700/50 bg-slate-800 p-6 text-slate-400">
                                    No sessions yet. Create one to start analyzing drafts.
                                </div>
                            }
                        >
                            <div class="flex flex-col gap-4">
                                <For each={sessionsQuery.data}>
                                    {(session) => (
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            onClick={() =>
                                                navigate(`/navigator/${session.id}`)
                                            }
                                            onKeyDown={(event) => {
                                                if (
                                                    event.key === "Enter" ||
                                                    event.key === " "
                                                ) {
                                                    event.preventDefault();
                                                    navigate(`/navigator/${session.id}`);
                                                }
                                            }}
                                            class="flex w-full items-center justify-between gap-4 rounded-lg border border-slate-700/50 bg-slate-800 p-5 text-left transition-colors hover:border-blue-400/50 hover:bg-slate-800/90"
                                        >
                                            <div class="min-w-0 flex-1">
                                                <div class="flex flex-wrap items-center gap-2">
                                                    <h3 class="truncate text-base font-semibold text-slate-100">
                                                        {session.name ??
                                                            "Untitled Session"}
                                                    </h3>
                                                    <span
                                                        class={`rounded-full px-2.5 py-1 text-xs font-medium ${
                                                            session.our_side === "blue"
                                                                ? "bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/40"
                                                                : "bg-red-500/15 text-red-300 ring-1 ring-red-500/40"
                                                        }`}
                                                    >
                                                        {session.our_side === "blue"
                                                            ? "Blue Side"
                                                            : "Red Side"}
                                                    </span>
                                                    <span class="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-slate-300">
                                                        {session.status}
                                                    </span>
                                                </div>
                                                <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
                                                    <span>
                                                        {getGameCount(session)} game
                                                        {getGameCount(session) !== 1
                                                            ? "s"
                                                            : ""}
                                                    </span>
                                                    <span>
                                                        Updated{" "}
                                                        {formatRelativeDate(
                                                            session.updatedAt
                                                        )}
                                                    </span>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={(event) =>
                                                    handleDeleteSession(event, session.id)
                                                }
                                                class="rounded-lg border border-slate-600 p-2 text-slate-400 transition-colors hover:border-red-400/60 hover:text-red-300"
                                                aria-label="Delete session"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Show>
                </section>
            </div>
        </div>
    );
};

export default NavigatorDashboard;
