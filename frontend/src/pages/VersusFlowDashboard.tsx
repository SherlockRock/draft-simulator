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
            <div class="mx-auto max-w-7xl p-8">
                {/* Hero intro section - centered panel within wider container */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative overflow-hidden rounded-xl border border-slate-700/50 bg-gradient-to-b from-slate-800 to-slate-800/50 p-8">
                        {/* Subtle accent glow */}
                        <div class="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-orange-500/10 blur-3xl" />

                        <div class="relative">
                            <div class="mb-6 flex items-center gap-3">
                                <span class="text-4xl">⚔️</span>
                                <h1 class="text-3xl font-bold text-slate-50">
                                    Versus Mode
                                </h1>
                            </div>

                            <ul class="mb-8 space-y-2 text-slate-300">
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-orange-400" />
                                    Create head-to-head competitive draft series (Best of
                                    1, 3, 5, or 7)
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-orange-400" />
                                    Share a single link for others to join as Blue
                                    Captain, Red Captain, or Spectator
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-orange-400" />
                                    Choose between Fearless, Standard, or Ironman draft
                                    styles
                                </li>
                            </ul>

                            <button
                                onClick={handleCreateVersus}
                                class="rounded-lg bg-gradient-to-r from-orange-600 to-orange-500 px-6 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 transition-all hover:from-orange-500 hover:to-orange-400 hover:shadow-orange-500/30"
                            >
                                Create New Versus Draft
                            </button>
                        </div>
                    </div>
                </div>

                {/* How it works - spans wider */}
                <section class="mb-12">
                    <h2 class="mb-5 text-xl font-semibold text-slate-200">
                        How It Works
                    </h2>
                    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <TutorialStep
                            number={1}
                            title="Create a Series"
                            description="Set team names, series length (Bo1/3/5/7), and choose Competitive or Scrim mode"
                            color="orange"
                        />
                        <TutorialStep
                            number={2}
                            title="Share the Link"
                            description="Send the unique share link to participants - they can join as captains or spectators"
                            color="orange"
                        />
                        <TutorialStep
                            number={3}
                            title="Ready Up & Draft"
                            description="Both captains must ready up to start. Then take turns picking and banning champions"
                            color="orange"
                        />
                        <TutorialStep
                            number={4}
                            title="Complete the Series"
                            description="Declare winners after each game. Drafts unlock sequentially as you progress"
                            color="orange"
                        />
                    </div>
                </section>

                {/* Recent Versus Activity - full width of container */}
                <Show when={user()}>
                    <section>
                        <h2 class="mb-5 text-xl font-semibold text-slate-200">
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
                                        <div class="rounded-lg border border-slate-700/50 bg-slate-800/50 p-8 text-center text-slate-400">
                                            No recent versus activity. Create your first
                                            versus draft to get started!
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

            <CreateVersusDraftDialog
                isOpen={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
            />
        </div>
    );
};

export default VersusFlowDashboard;
