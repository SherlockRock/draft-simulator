import { Component, For, Show, Switch, Match, onCleanup, createSignal, createMemo } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { useInfiniteQuery } from "@tanstack/solid-query";
import { fetchRecentActivity } from "../utils/actions";
import ActivityItem from "./ActivityItem";

type SortOption = "recent" | "oldest" | "name_asc" | "name_desc";
type AccentColor = "teal" | "purple" | "orange";

interface ActivityListProps {
    queryKeyBase: string[];
    resourceType?: "draft" | "canvas" | "versus";
    accentColor?: AccentColor;
    emptyMessage?: string;
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
    { value: "recent", label: "Most Recent" },
    { value: "oldest", label: "Oldest First" },
    { value: "name_asc", label: "Name (A-Z)" },
    { value: "name_desc", label: "Name (Z-A)" },
];

const ActivityList: Component<ActivityListProps> = (props) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const [searchInput, setSearchInput] = createSignal(searchParams.search || "");
    let debounceTimeout: number | undefined;

    // Read sort from URL, default to "recent"
    const currentSort = createMemo(() =>
        (searchParams.sort as SortOption) || "recent"
    );

    // Read search from URL
    const currentSearch = createMemo(() => searchParams.search || "");

    // Debounce search input
    const handleSearchInput = (value: string) => {
        setSearchInput(value);
        clearTimeout(debounceTimeout);
        debounceTimeout = window.setTimeout(() => {
            setSearchParams({ search: value || undefined, sort: currentSort() });
        }, 300);
    };

    // Handle sort change (immediate)
    const handleSortChange = (value: SortOption) => {
        setSearchParams({ search: currentSearch() || undefined, sort: value });
    };

    onCleanup(() => clearTimeout(debounceTimeout));

    const activitiesQuery = useInfiniteQuery(() => ({
        queryKey: [...props.queryKeyBase, currentSearch(), currentSort()],
        queryFn: ({ pageParam = 0 }) =>
            fetchRecentActivity(pageParam, props.resourceType, currentSearch(), currentSort()),
        getNextPageParam: (lastPage) => lastPage.nextPage,
        initialPageParam: 0,
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

    const accentClasses = createMemo(() => {
        switch (props.accentColor) {
            case "purple":
                return {
                    ring: "focus:ring-purple-500",
                    border: "focus:border-purple-500",
                    button: "bg-purple-600 hover:bg-purple-500",
                };
            case "orange":
                return {
                    ring: "focus:ring-orange-500",
                    border: "focus:border-orange-500",
                    button: "bg-orange-600 hover:bg-orange-500",
                };
            default:
                return {
                    ring: "focus:ring-teal-500",
                    border: "focus:border-teal-500",
                    button: "bg-teal-600 hover:bg-teal-500",
                };
        }
    });

    return (
        <div>
            {/* Filter Controls */}
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {/* Search Input */}
                <div class="relative flex-1 sm:max-w-xs">
                    <svg
                        class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                        />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search activities..."
                        value={searchInput()}
                        onInput={(e) => handleSearchInput(e.currentTarget.value)}
                        class={`w-full rounded-md border border-slate-600 bg-slate-700 py-2 pl-10 pr-3 text-slate-50 placeholder-slate-400 focus:outline-none focus:ring-2 ${accentClasses().ring} ${accentClasses().border}`}
                    />
                </div>

                {/* Sort Dropdown */}
                <div class="flex items-center gap-2">
                    <span class="text-sm text-slate-400">Sort:</span>
                    <select
                        value={currentSort()}
                        onChange={(e) => handleSortChange(e.currentTarget.value as SortOption)}
                        class={`rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:outline-none focus:ring-2 ${accentClasses().ring} ${accentClasses().border}`}
                    >
                        <For each={SORT_OPTIONS}>
                            {(option) => (
                                <option value={option.value}>{option.label}</option>
                            )}
                        </For>
                    </select>
                </div>
            </div>

            {/* Activity Grid */}
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
                                {currentSearch()
                                    ? `No activities matching "${currentSearch()}"`
                                    : props.emptyMessage || "No recent activity"}
                            </div>
                        }
                    >
                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            <For
                                each={activitiesQuery.data?.pages.flatMap(
                                    (page) => page.activities
                                )}
                            >
                                {(activity) => <ActivityItem activity={activity} />}
                            </For>
                        </div>
                        {/* Sentinel element for infinite scroll */}
                        <Show when={activitiesQuery.hasNextPage}>
                            <div ref={setupObserver} class="py-4 text-center">
                                <Show
                                    when={activitiesQuery.isFetchingNextPage}
                                    fallback={
                                        <div class="text-slate-500">Scroll for more...</div>
                                    }
                                >
                                    <div class="text-slate-400">Loading more...</div>
                                </Show>
                            </div>
                        </Show>
                    </Show>
                </Match>
            </Switch>
        </div>
    );
};

export default ActivityList;
