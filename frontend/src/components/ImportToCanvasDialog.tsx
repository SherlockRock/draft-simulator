import { Component, createSignal, For, Show, createMemo } from "solid-js";
import { useQuery, createMutation, useQueryClient } from "@tanstack/solid-query";
import {
    fetchUserVersusSeries,
    importDraftToCanvas,
    importSeriesToCanvas
} from "../utils/actions";
import { VersusDraftListItem } from "../utils/schemas";
import toast from "solid-toast";

type Props = {
    canvasId: string;
    positionX: number;
    positionY: number;
    onClose: () => void;
    onSuccess: () => void;
};

export const ImportToCanvasDialog: Component<Props> = (props) => {
    const queryClient = useQueryClient();
    const [searchQuery, setSearchQuery] = createSignal("");
    const [selectedSeriesId, setSelectedSeriesId] = createSignal<string | null>(null);
    const [expandedSeriesId, setExpandedSeriesId] = createSignal<string | null>(null);
    const [selectedGameId, setSelectedGameId] = createSignal<string | null>(null);

    const seriesQuery = useQuery(() => ({
        queryKey: ["userVersusSeries"],
        queryFn: fetchUserVersusSeries
    }));

    const importDraftMutation = createMutation(() => ({
        mutationFn: (draftId: string) =>
            importDraftToCanvas({
                canvasId: props.canvasId,
                draftId,
                positionX: props.positionX,
                positionY: props.positionY
            }),
        onSuccess: () => {
            toast.success("Draft imported to canvas");
            queryClient.invalidateQueries({ queryKey: ["canvas", props.canvasId] });
            props.onSuccess();
            props.onClose();
        },
        onError: (error: Error) => {
            toast.error(error.message);
        }
    }));

    const importSeriesMutation = createMutation(() => ({
        mutationFn: (versusDraftId: string) =>
            importSeriesToCanvas({
                canvasId: props.canvasId,
                versusDraftId,
                positionX: props.positionX,
                positionY: props.positionY
            }),
        onSuccess: () => {
            toast.success("Series imported to canvas");
            queryClient.invalidateQueries({ queryKey: ["canvas", props.canvasId] });
            props.onSuccess();
            props.onClose();
        },
        onError: (error: Error) => {
            toast.error(error.message);
        }
    }));

    const filteredSeries = createMemo(() => {
        const series = seriesQuery.data || [];
        const query = searchQuery().toLowerCase();
        if (!query) return series;
        return series.filter((s: VersusDraftListItem) => s.name.toLowerCase().includes(query));
    });

    const getSeriesScore = (series: VersusDraftListItem) => {
        if (!series.Drafts) return { blue: 0, red: 0 };
        const blue = series.Drafts.filter((d) => d.winner === "blue").length;
        const red = series.Drafts.filter((d) => d.winner === "red").length;
        return { blue, red };
    };

    const handleImport = () => {
        if (selectedGameId()) {
            // Import individual game
            importDraftMutation.mutate(selectedGameId()!);
        } else if (selectedSeriesId()) {
            // Import full series
            importSeriesMutation.mutate(selectedSeriesId()!);
        }
    };

    const canImport = () => {
        return !!selectedSeriesId() || !!selectedGameId();
    };

    return (
        <div class="flex w-[500px] flex-col gap-4">
            <h2 class="text-lg font-bold text-slate-50">Import Versus Series</h2>

            {/* Search */}
            <input
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                class="rounded-md border border-slate-500 bg-slate-700 px-3 py-2 text-slate-50 placeholder-slate-400"
            />

            {/* Content */}
            <div class="max-h-80 min-h-40 overflow-y-auto rounded-md border border-slate-500 bg-slate-800">
                <Show
                        when={!seriesQuery.isPending}
                        fallback={<div class="p-4 text-slate-400">Loading...</div>}
                    >
                        <Show
                            when={filteredSeries().length > 0}
                            fallback={
                                <div class="p-4 text-slate-400">No series found</div>
                            }
                        >
                            <For each={filteredSeries()}>
                                {(series: VersusDraftListItem) => {
                                    const score = getSeriesScore(series);
                                    const isExpanded = () =>
                                        expandedSeriesId() === series.id;

                                    return (
                                        <div class="border-b border-slate-700">
                                            <div
                                                class="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-700"
                                                classList={{
                                                    "bg-teal-900/50":
                                                        selectedSeriesId() ===
                                                            series.id && !selectedGameId()
                                                }}
                                                onClick={() => {
                                                    if (isExpanded()) {
                                                        setExpandedSeriesId(null);
                                                    } else {
                                                        setExpandedSeriesId(series.id);
                                                    }
                                                    setSelectedSeriesId(series.id);
                                                    setSelectedGameId(null);
                                                }}
                                            >
                                                <div class="flex flex-1 flex-col">
                                                    <div class="flex items-center gap-2">
                                                        <span class="font-medium text-slate-50">
                                                            {series.name}
                                                        </span>
                                                        <span
                                                            class="rounded px-2 py-0.5 text-xs capitalize"
                                                            classList={{
                                                                "bg-slate-500/30 text-slate-300":
                                                                    !series.type ||
                                                                    series.type ===
                                                                        "standard",
                                                                "bg-purple-500/30 text-purple-300":
                                                                    series.type ===
                                                                    "fearless",
                                                                "bg-orange-500/30 text-orange-300":
                                                                    series.type ===
                                                                    "ironman"
                                                            }}
                                                        >
                                                            {series.type || "standard"}
                                                        </span>
                                                        <span
                                                            class="rounded px-2 py-0.5 text-xs"
                                                            classList={{
                                                                "bg-teal-500/30 text-teal-300":
                                                                    series.competitive,
                                                                "bg-slate-500/30 text-slate-400":
                                                                    !series.competitive
                                                            }}
                                                        >
                                                            {series.competitive
                                                                ? "Competitive"
                                                                : "Scrim"}
                                                        </span>
                                                    </div>
                                                    <span class="text-sm text-slate-400">
                                                        {series.blueTeamName} vs{" "}
                                                        {series.redTeamName} ({score.blue}
                                                        -{score.red})
                                                    </span>
                                                </div>
                                                <button
                                                    class="rounded bg-teal-700 px-3 py-1 text-sm text-slate-50 hover:bg-teal-600"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelectedSeriesId(series.id);
                                                        setSelectedGameId(null);
                                                        importSeriesMutation.mutate(
                                                            series.id
                                                        );
                                                    }}
                                                >
                                                    Import Series
                                                </button>
                                                <span class="text-slate-400">
                                                    {isExpanded() ? "▲" : "▼"}
                                                </span>
                                            </div>

                                            <Show
                                                when={isExpanded() && series.Drafts}
                                                keyed
                                            >
                                                {(drafts) => (
                                                    <div class="bg-slate-900 px-4 py-2">
                                                        <For
                                                            each={[...drafts].sort(
                                                                (a, b) =>
                                                                    (a.seriesIndex ?? 0) -
                                                                    (b.seriesIndex ?? 0)
                                                            )}
                                                        >
                                                            {(draft) => (
                                                                <div
                                                                    class="flex cursor-pointer items-center gap-2 rounded px-2 py-2 hover:bg-slate-800"
                                                                    classList={{
                                                                        "bg-teal-900/50":
                                                                            selectedGameId() ===
                                                                            draft.id
                                                                    }}
                                                                    onClick={() => {
                                                                        setSelectedGameId(
                                                                            draft.id
                                                                        );
                                                                        setSelectedSeriesId(
                                                                            null
                                                                        );
                                                                    }}
                                                                >
                                                                    <span class="text-sm text-slate-300">
                                                                        Game{" "}
                                                                        {(draft.seriesIndex ??
                                                                            0) + 1}
                                                                    </span>
                                                                    <Show
                                                                        when={
                                                                            draft.completed &&
                                                                            draft.winner
                                                                        }
                                                                    >
                                                                        <span
                                                                            class="text-xs"
                                                                            classList={{
                                                                                "text-blue-400":
                                                                                    draft.winner ===
                                                                                    "blue",
                                                                                "text-red-400":
                                                                                    draft.winner ===
                                                                                    "red"
                                                                            }}
                                                                        >
                                                                            {draft.winner ===
                                                                            "blue"
                                                                                ? series.blueTeamName
                                                                                : series.redTeamName}{" "}
                                                                            wins
                                                                        </span>
                                                                    </Show>
                                                                    <Show
                                                                        when={
                                                                            draft.completed &&
                                                                            !draft.winner
                                                                        }
                                                                    >
                                                                        <span class="text-xs text-yellow-400">
                                                                            Complete
                                                                        </span>
                                                                    </Show>
                                                                    <Show
                                                                        when={
                                                                            !draft.completed
                                                                        }
                                                                    >
                                                                        <span class="text-xs text-slate-500">
                                                                            Incomplete
                                                                        </span>
                                                                    </Show>
                                                                </div>
                                                            )}
                                                        </For>
                                                    </div>
                                                )}
                                            </Show>
                                        </div>
                                    );
                                }}
                            </For>
                        </Show>
                    </Show>
            </div>

            {/* Footer */}
            <div class="flex justify-end gap-2">
                <button
                    class="rounded-md bg-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-500"
                    onClick={props.onClose}
                >
                    Cancel
                </button>
                <button
                    class="rounded-md bg-teal-700 px-4 py-2 text-sm text-slate-50 hover:bg-teal-600 disabled:opacity-50"
                    disabled={
                        !canImport() ||
                        importDraftMutation.isPending ||
                        importSeriesMutation.isPending
                    }
                    onClick={handleImport}
                >
                    {importDraftMutation.isPending || importSeriesMutation.isPending
                        ? "Importing..."
                        : "Import"}
                </button>
            </div>
        </div>
    );
};
