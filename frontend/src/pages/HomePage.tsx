import { Component, For, Match, Show, Switch, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useInfiniteQuery } from "@tanstack/solid-query";
import FlowCard from "../components/FlowCard";
import ActivityItem from "../components/ActivityItem";
import { fetchRecentActivity } from "../utils/actions";
import { useUser } from "../userProvider";

const HomePage: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();

    const activitiesQuery = useInfiniteQuery(() => ({
        queryKey: ["recentActivity"],
        queryFn: ({ pageParam = 0 }) => fetchRecentActivity(pageParam),
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

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-6xl p-8">
                <h1 class="mb-8 text-4xl font-bold text-slate-50">
                    Welcome to Draft Simulator
                </h1>

                {/* Flow Navigation Cards */}
                <div class="mb-12">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        Choose Your Workflow
                    </h2>
                    <div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                        <FlowCard
                            title="Draft"
                            description="Create and manage individual drafts"
                            icon="📄"
                            onClick={() => navigate("/draft")}
                            flowType="draft"
                        />
                        <FlowCard
                            title="Canvas"
                            description="Visual workspace for organizing drafts"
                            icon="🎨"
                            onClick={() => navigate("/canvas")}
                            flowType="canvas"
                        />
                        <FlowCard
                            title="Versus"
                            description="Head-to-head competitive draft series"
                            icon="⚔️"
                            onClick={() => navigate("/versus")}
                            flowType="versus"
                        />
                    </div>
                </div>

                {/* Recent Activity Feed - Only show for signed-in users */}
                <Show when={user()}>
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        Recent Activity
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
                                    <div class="text-slate-400">No recent activity</div>
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
                </Show>
            </div>
        </div>
    );
};

export default HomePage;
