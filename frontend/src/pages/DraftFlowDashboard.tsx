import { Component, For, Show, Switch, Match, onCleanup, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useInfiniteQuery } from "@tanstack/solid-query";
import TutorialStep from "../components/TutorialStep";
import ActivityItem from "../components/ActivityItem";
import { fetchRecentActivity } from "../utils/actions";
import { useUser } from "../userProvider";
import { CreateDraftDialog } from "../components/CreateDraftDialog";

const DraftFlowDashboard: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();
    const [showCreateDialog, setShowCreateDialog] = createSignal(false);

    const activitiesQuery = useInfiniteQuery(() => ({
        queryKey: ["recentActivity", "draft"],
        queryFn: ({ pageParam = 0 }) => fetchRecentActivity(pageParam, "draft"),
        getNextPageParam: (lastPage) => lastPage.nextPage,
        enabled: !!user(),
        initialPageParam: 0
    }));

    // Intersection observer for infinite scroll
    const setupObserver = (element: HTMLDivElement) => {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && !activitiesQuery.isFetchingNextPage) {
                    activitiesQuery.fetchNextPage();
                }
            },
            { threshold: 0.1 }
        );

        observer.observe(element);

        onCleanup(() => observer.disconnect());
    };

    const handleCreateDraft = () => {
        setShowCreateDialog(true);
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-7xl p-8">
                {/* Intro section - centered panel within wider container */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative overflow-hidden rounded-xl border border-slate-700/50 bg-gradient-to-b from-slate-800 to-slate-800/50 p-8">
                        {/* Subtle accent glow */}
                        <div class="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl" />

                        <div class="relative">
                            <div class="mb-6 flex items-center gap-3">
                                <span class="text-4xl">📄</span>
                                <h1 class="text-3xl font-bold text-slate-50">
                                    Draft Mode
                                </h1>
                            </div>

                            <ul class="mb-8 space-y-2 text-slate-300">
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />
                                    Create a new draft to start building your team
                                    composition
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />
                                    Use the searchable champion table to find and select
                                    champions
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />
                                    Drag and drop champions into ban and pick slots
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />
                                    Share your drafts with collaborators for real-time
                                    editing
                                </li>
                            </ul>

                            <button
                                onClick={handleCreateDraft}
                                class="rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-3 font-semibold text-white shadow-lg shadow-blue-500/20 transition-all hover:from-blue-500 hover:to-blue-400 hover:shadow-blue-500/30"
                            >
                                Create New Draft
                            </button>
                        </div>
                    </div>
                </div>

                {/* How it works - spans wider */}
                <section class="mb-12">
                    <h2 class="mb-5 text-xl font-semibold text-slate-200">
                        How It Works
                    </h2>
                    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <TutorialStep
                            number={1}
                            title="Create Your Draft"
                            description="Click the button above or use the draft list panel on the left to create a new draft"
                            color="blue"
                        />
                        <TutorialStep
                            number={2}
                            title="Select Champions"
                            description="Search, filter by role, or drag champions from the table into your draft"
                            color="blue"
                        />
                        <TutorialStep
                            number={3}
                            title="Collaborate"
                            description="Share your draft link with teammates for live collaboration"
                            color="blue"
                        />
                    </div>
                </section>

                {/* Recent Draft Activity - full width of container */}
                <Show when={user()}>
                    <section>
                        <h2 class="mb-5 text-xl font-semibold text-slate-200">
                            Recent Draft Activity
                        </h2>
                        <Switch>
                            <Match when={activitiesQuery.isLoading}>
                                <div class="text-slate-400">Loading activity...</div>
                            </Match>
                            <Match when={activitiesQuery.isError}>
                                <div class="text-red-400">Failed to load activity</div>
                            </Match>
                            <Match when={activitiesQuery.data}>
                                <Show
                                    when={activitiesQuery.data?.pages.some(
                                        (page) => page.activities.length > 0
                                    )}
                                    fallback={
                                        <div class="rounded-lg border border-slate-700/50 bg-slate-800/50 p-8 text-center text-slate-400">
                                            No recent draft activity
                                        </div>
                                    }
                                >
                                    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                        <For
                                            each={activitiesQuery.data?.pages.flatMap(
                                                (page) => page.activities
                                            )}
                                        >
                                            {(activity) => (
                                                <ActivityItem activity={activity} />
                                            )}
                                        </For>
                                    </div>
                                    {/* Sentinel element for infinite scroll */}
                                    <Show when={activitiesQuery.hasNextPage}>
                                        <div ref={setupObserver} class="py-4 text-center">
                                            <Show
                                                when={activitiesQuery.isFetchingNextPage}
                                                fallback={
                                                    <div class="text-slate-500">
                                                        Scroll for more...
                                                    </div>
                                                }
                                            >
                                                <div class="text-slate-400">
                                                    Loading more...
                                                </div>
                                            </Show>
                                        </div>
                                    </Show>
                                </Show>
                            </Match>
                        </Switch>
                    </section>
                </Show>
            </div>

            <CreateDraftDialog
                isOpen={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
                onSuccess={(draftId) => {
                    setShowCreateDialog(false);
                    navigate(`/draft/${draftId}`);
                }}
            />
        </div>
    );
};

export default DraftFlowDashboard;
