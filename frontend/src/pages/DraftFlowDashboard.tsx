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
            <div class="mx-auto max-w-4xl p-8">
                <h1 class="mb-4 text-4xl font-bold text-slate-50">
                    Welcome to Draft Mode
                </h1>

                <section class="mb-8">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        Getting Started
                    </h2>
                    <ul class="list-inside list-disc space-y-2 text-slate-300">
                        <li>
                            Create a new draft to start building your team composition
                        </li>
                        <li>
                            Use the searchable champion table to find and select champions
                        </li>
                        <li>Drag and drop champions into ban and pick slots</li>
                        <li>
                            Share your drafts with collaborators for real-time editing
                        </li>
                    </ul>
                </section>

                <section class="mb-8">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        How It Works
                    </h2>
                    <div class="flex flex-col gap-4">
                        <TutorialStep
                            number={1}
                            title="Create Your First Draft"
                            description="Click the button below or use the draft list panel on the left to create a new draft"
                        />
                        <TutorialStep
                            number={2}
                            title="Select Champions"
                            description="Search, filter by role, or drag champions from the table into your draft"
                        />
                        <TutorialStep
                            number={3}
                            title="Collaborate"
                            description="Share your draft link with teammates for live collaboration"
                        />
                    </div>
                </section>

                <button
                    onClick={handleCreateDraft}
                    class="mb-12 rounded-md bg-teal-700 px-8 py-4 text-xl font-medium text-slate-50 transition-colors hover:bg-teal-600"
                >
                    Create New Draft
                </button>

                {/* Recent Draft Activity */}
                <Show when={user()}>
                    <section>
                        <h2 class="mb-4 text-2xl font-semibold text-slate-200">
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
                                        <div class="text-slate-400">
                                            No recent draft activity
                                        </div>
                                    }
                                >
                                    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
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
