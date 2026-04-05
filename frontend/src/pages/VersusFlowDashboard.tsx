import { Component, createSignal, createEffect, Show } from "solid-js";
import { useQuery, useInfiniteQuery } from "@tanstack/solid-query";
import { Title, Meta } from "@solidjs/meta";
import { Swords } from "lucide-solid";
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
            // Wait for fresh data - stale cache may show empty activity on remount
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
        <div class="flex-1 overflow-auto bg-darius-bg bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <Title>Versus - First Pick</Title>
            <Meta
                name="description"
                content="Real-time collaborative drafting against opponents."
            />
            <div class="mx-auto flex min-h-full max-w-7xl flex-col p-8">
                {/* Inline banner */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex items-center overflow-hidden rounded-xl border border-darius-border/50 bg-darius-card">
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-darius-crimson/[0.08] to-transparent" />

                        {/* Title + tagline */}
                        <div class="relative flex flex-1 items-center gap-3 py-6 pl-8 pr-4">
                            <Swords size={28} class="text-darius-crimson" />
                            <div>
                                <h1 class="text-2xl font-bold text-darius-text-primary">
                                    Versus Mode
                                </h1>
                                <p class="text-sm text-darius-text-secondary">
                                    Head-to-head competitive draft series
                                </p>
                            </div>
                        </div>

                        {/* CTA button */}
                        <div class="relative pr-8">
                            <button
                                onClick={handleCreateVersus}
                                class="rounded-lg bg-darius-crimson px-5 py-2.5 text-sm font-semibold text-darius-text-primary shadow-[0_4px_12px_rgba(224,56,72,0.15)] transition-all hover:shadow-[0_6px_16px_rgba(224,56,72,0.22)] hover:brightness-125"
                            >
                                Create New Versus Draft
                            </button>
                        </div>
                    </div>
                </div>

                {/* Recent Versus Activity - full width of container */}
                <Show when={user()}>
                    <section class="flex flex-1 flex-col">
                        <h2 class="mb-5 text-xl font-semibold text-darius-text-primary">
                            Recent Versus Activity
                        </h2>
                        <ActivityList
                            queryKeyBase={["recentActivity", "versus"]}
                            resourceType="versus"
                            accentColor="crimson"
                            emptyMessage="No recent versus activity. Create your first versus draft to get started!"
                            keyboardControls={user()?.keyboard_controls ?? false}
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
