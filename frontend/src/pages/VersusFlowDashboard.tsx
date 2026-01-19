import { Component, createSignal, For, Show, Switch, Match, onCleanup } from "solid-js";
import { useInfiniteQuery } from "@tanstack/solid-query";
import TutorialStep from "../components/TutorialStep";
import ActivityItem from "../components/ActivityItem";
import { fetchRecentActivity } from "../utils/actions";
import { useUser } from "../userProvider";
import { CreateVersusDraftDialog } from "../components/CreateVersusDraftDialog";

const VersusFlowDashboard: Component = () => {
    const context = useUser();
    const [user] = context();
    const [showCreateDialog, setShowCreateDialog] = createSignal(false);

    const activitiesQuery = useInfiniteQuery(() => ({
        queryKey: ["recentActivity", "versus"],
        queryFn: ({ pageParam = 0 }) => fetchRecentActivity(pageParam, "versus"),
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

    const handleCreateVersus = () => {
        setShowCreateDialog(true);
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-4xl p-8">
                <h1 class="mb-4 text-4xl font-bold text-slate-50">
                    Welcome to Versus Mode
                </h1>

                <section class="mb-8">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        Getting Started
                    </h2>
                    <ul class="list-inside list-disc space-y-2 text-slate-300">
                        <li>
                            Create head-to-head competitive draft series (Best of 1, 3, 5,
                            or 7)
                        </li>
                        <li>
                            Choose between Competitive mode (requires approval for
                            pauses/changes) or Scrim mode (instant actions)
                        </li>
                        <li>
                            Share a single link for others to join as Blue Captain, Red
                            Captain, or Spectator
                        </li>
                        <li>
                            Experience real-time drafting with 30-second pick timers and
                            auto-lock
                        </li>
                        <li>Declare winners after each game and track series progress</li>
                    </ul>
                </section>

                <section class="mb-8">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        How It Works
                    </h2>
                    <div class="flex flex-col gap-4">
                        <TutorialStep
                            number={1}
                            title="Create a Versus Draft Series"
                            description="Set team names, series length (Bo1/3/5/7), and choose Competitive or Scrim mode"
                        />
                        <TutorialStep
                            number={2}
                            title="Share the Link"
                            description="Send the unique share link to participants - they can join as captains or spectators"
                        />
                        <TutorialStep
                            number={3}
                            title="Ready Up & Draft"
                            description="Both captains must ready up to start. Then take turns picking and banning champions within the 30-second timer"
                        />
                        <TutorialStep
                            number={4}
                            title="Complete the Series"
                            description="Declare winners after each game. Drafts unlock sequentially as you progress through the series"
                        />
                    </div>
                </section>

                <button
                    onClick={handleCreateVersus}
                    class="mb-12 rounded-md bg-teal-700 px-8 py-4 text-xl font-medium text-slate-50 transition-colors hover:bg-teal-600"
                >
                    Create New Versus Draft
                </button>

                {/* Recent Versus Activity */}
                <Show when={user()}>
                    <section>
                        <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                            Recent Versus Activity
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
                                            No recent versus activity. Create your first
                                            versus draft to get started!
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

            <CreateVersusDraftDialog
                isOpen={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
            />
        </div>
    );
};

export default VersusFlowDashboard;
