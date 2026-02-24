import { Component, createSignal, createEffect, Show } from "solid-js";
import { useQuery, useInfiniteQuery } from "@tanstack/solid-query";
import TutorialStep from "../components/TutorialStep";
import ActivityList from "../components/ActivityList";
import { useUser } from "../userProvider";
import { CreateVersusDraftDialog } from "../components/CreateVersusDraftDialog";
import { fetchRecentActivity, fetchUserDetails } from "../utils/actions";

const VersusFlowDashboard: Component = () => {
    const context = useUser();
    const [user] = context();
    const [showCreateDialog, setShowCreateDialog] = createSignal(false);

    // Observe user query state reactively (shares cache with userProvider)
    const userQuery = useQuery(() => ({
        queryKey: ["user"],
        queryFn: fetchUserDetails,
        staleTime: 1000 * 60 * 60 * 24,
        retry: false
    }));

    // Query to check if user has any versus activity (shares cache with ActivityList)
    const activityQuery = useInfiniteQuery(() => ({
        queryKey: ["recentActivity", "versus", "", "recent"],
        queryFn: ({ pageParam = 0 }) =>
            fetchRecentActivity(pageParam, "versus", "", "recent"),
        getNextPageParam: (lastPage) => lastPage.nextPage,
        initialPageParam: 0,
        enabled: !!userQuery.data
    }));

    // Auto-open create modal for users with no versus activity
    createEffect(() => {
        // Wait for auth to resolve
        if (userQuery.isLoading) return;

        if (userQuery.data) {
            // Signed-in: wait for activity data before deciding
            const data = activityQuery.data;
            if (data === undefined) return;

            if (!data.pages.some((p) => p.activities.length > 0)) {
                setShowCreateDialog(true);
            }
        } else {
            // Anonymous user
            setShowCreateDialog(true);
        }
    });

    const handleCreateVersus = () => {
        setShowCreateDialog(true);
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-7xl p-8">
                {/* Hero intro section - centered panel within wider container */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800">
                        {/* Subtle gradient overlay */}
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-orange-500/5 to-transparent" />

                        {/* Side accent stripe */}
                        <div class="w-2 flex-shrink-0 bg-orange-500" />

                        <div class="relative p-8">
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
                                class="rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white transition-all hover:bg-orange-400"
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
                        <ActivityList
                            queryKeyBase={["recentActivity", "versus"]}
                            resourceType="versus"
                            accentColor="orange"
                            emptyMessage="No recent versus activity. Create your first versus draft to get started!"
                        />
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
