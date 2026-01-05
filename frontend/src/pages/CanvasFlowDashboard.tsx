import { Component, For, Show, Switch, Match, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useInfiniteQuery } from "@tanstack/solid-query";
import TutorialStep from "../components/TutorialStep";
import ActivityItem from "../components/ActivityItem";
import { fetchRecentActivity } from "../utils/actions";
import { useUser } from "../userProvider";
import toast from "solid-toast";

const CanvasFlowDashboard: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();

    const activitiesQuery = useInfiniteQuery(() => ({
        queryKey: ["recentActivity", "canvas"],
        queryFn: ({ pageParam = 0 }) => fetchRecentActivity(pageParam, "canvas"),
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

    const handleCreateCanvas = async () => {
        try {
            // TODO: Implement canvas creation API endpoint
            // For now, show a coming soon message
            toast.success("Canvas creation coming soon!");
            navigate("/canvas");
        } catch (error) {
            console.error("Failed to create canvas:", error);
            toast.error("Failed to create canvas");
        }
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-4xl p-8">
                <h1 class="mb-4 text-4xl font-bold text-slate-50">
                    Welcome to Canvas Mode
                </h1>

                <section class="mb-8">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        What is Canvas?
                    </h2>
                    <p class="mb-4 text-slate-300">
                        Canvas is an infinite workspace for visually organizing and
                        connecting your drafts.
                    </p>
                    <ul class="list-inside list-disc space-y-2 text-slate-300">
                        <li>Create and position draft cards anywhere on the canvas</li>
                        <li>Draw connections between related drafts</li>
                        <li>Collaborate with teammates in real-time</li>
                        <li>Organize complex draft scenarios and strategies</li>
                    </ul>
                </section>

                <section class="mb-8">
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        How It Works
                    </h2>
                    <div class="flex flex-col gap-4">
                        <TutorialStep
                            number={1}
                            title="Create a Canvas"
                            description="Use the canvas selector in the left panel to create your first canvas"
                        />
                        <TutorialStep
                            number={2}
                            title="Add Drafts"
                            description="Double-click the canvas to create draft cards, or add existing standalone drafts"
                        />
                        <TutorialStep
                            number={3}
                            title="Make Connections"
                            description="Enter connection mode to draw relationships between drafts"
                        />
                    </div>
                </section>

                <button
                    onClick={handleCreateCanvas}
                    class="mb-12 rounded-md bg-teal-700 px-8 py-4 text-xl font-medium text-slate-50 transition-colors hover:bg-teal-600"
                >
                    Create New Canvas
                </button>

                {/* Recent Canvas Activity */}
                <Show when={user()}>
                    <section class="mt-12">
                        <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                            Recent Canvas Activity
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
                                            No recent canvas activity
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
        </div>
    );
};

export default CanvasFlowDashboard;
