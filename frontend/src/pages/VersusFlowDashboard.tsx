import { Component, createSignal, createEffect, Show } from "solid-js";
import { useQuery, useInfiniteQuery } from "@tanstack/solid-query";
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
            // Wait for fresh data — stale cache may show empty activity on remount
            if (activityQuery.isFetching) return;
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
        <div class="flex-1 overflow-auto bg-slate-900 bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto flex min-h-full max-w-7xl flex-col justify-center p-8">
                {/* Inline banner */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex items-center overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800">
                        {/* Subtle gradient overlay */}
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-orange-500/5 to-transparent" />

                        {/* Side accent stripe */}
                        <div class="absolute inset-y-0 left-0 w-2 bg-orange-500" />

                        {/* Title + tagline */}
                        <div class="relative flex flex-1 items-center gap-3 py-6 pl-8 pr-4">
                            <span class="text-4xl">⚔️</span>
                            <div>
                                <h1 class="text-2xl font-bold text-slate-50">
                                    Versus Mode
                                </h1>
                                <p class="text-sm text-slate-300">
                                    Head-to-head competitive draft series
                                </p>
                            </div>
                        </div>

                        {/* CTA button */}
                        <div class="relative pr-8">
                            <button
                                onClick={handleCreateVersus}
                                class="rounded-lg bg-orange-500 px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-orange-500/25 transition-all hover:bg-orange-400 hover:shadow-orange-500/35"
                            >
                                Create New Versus Draft
                            </button>
                        </div>
                    </div>
                </div>

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
