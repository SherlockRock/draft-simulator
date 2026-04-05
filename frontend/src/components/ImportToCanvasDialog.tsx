import { Component, createSignal, For, Show, createMemo } from "solid-js";
import { useQuery, createMutation } from "@tanstack/solid-query";
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
        return series.filter((s: VersusDraftListItem) =>
            s.name.toLowerCase().includes(query)
        );
    });

    const getSeriesScore = (series: VersusDraftListItem) => {
        if (!series.Drafts) return { blue: 0, red: 0 };
        let team1Wins = 0;
        let team2Wins = 0;
        series.Drafts.forEach((d) => {
            if (!d.winner) return;
            const bst = d.blueSideTeam || 1;
            const team1Won =
                (d.winner === "blue" && bst === 1) || (d.winner === "red" && bst === 2);
            if (team1Won) team1Wins++;
            else team2Wins++;
        });
        return { blue: team1Wins, red: team2Wins };
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
            <h2 class="text-lg font-bold text-darius-text-primary">
                Import Versus Series
            </h2>

            {/* Search */}
            <input
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                class="rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary placeholder:text-darius-text-secondary"
            />

            {/* Content */}
            <div class="max-h-80 min-h-40 overflow-y-auto rounded-md border border-darius-border bg-darius-card">
                <Show
                    when={!seriesQuery.isPending}
                    fallback={
                        <div class="p-4 text-darius-text-secondary">Loading...</div>
                    }
                >
                    <Show
                        when={filteredSeries().length > 0}
                        fallback={
                            <div class="p-4 text-darius-text-secondary">
                                No series found
                            </div>
                        }
                    >
                        <For each={filteredSeries()}>
                            {(series: VersusDraftListItem) => {
                                const score = getSeriesScore(series);
                                const isExpanded = () => expandedSeriesId() === series.id;

                                return (
                                    <div class="border-b border-darius-border">
                                        <div
                                            class="flex cursor-pointer items-center gap-3 bg-darius-card-hover px-4 py-3"
                                            classList={{
                                                "bg-darius-purple/15":
                                                    selectedSeriesId() === series.id &&
                                                    !selectedGameId()
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
                                                    <span class="font-medium text-darius-text-primary">
                                                        {series.name}
                                                    </span>
                                                    <span
                                                        class="rounded px-2 py-0.5 text-xs capitalize"
                                                        classList={{
                                                            "bg-darius-card text-darius-text-secondary":
                                                                !series.type ||
                                                                series.type ===
                                                                    "standard",
                                                            "bg-darius-purple/30 text-darius-purple-bright":
                                                                series.type ===
                                                                "fearless",
                                                            "bg-darius-crimson/30 text-darius-crimson":
                                                                series.type === "ironman"
                                                        }}
                                                    >
                                                        {series.type || "standard"}
                                                    </span>
                                                    <span
                                                        class="rounded px-2 py-0.5 text-xs"
                                                        classList={{
                                                            "bg-darius-ember/30 text-darius-ember":
                                                                series.competitive,
                                                            "bg-darius-card text-darius-text-secondary":
                                                                !series.competitive
                                                        }}
                                                    >
                                                        {series.competitive
                                                            ? "Competitive"
                                                            : "Scrim"}
                                                    </span>
                                                </div>
                                                <span class="text-sm text-darius-text-secondary">
                                                    {series.blueTeamName} vs{" "}
                                                    {series.redTeamName} ({score.blue}-
                                                    {score.red})
                                                </span>
                                            </div>
                                            <button
                                                class="rounded bg-darius-ember bg-darius-ember px-3 py-1 text-sm text-darius-text-primary"
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
                                            <span class="text-darius-text-secondary">
                                                {isExpanded() ? "▲" : "▼"}
                                            </span>
                                        </div>

                                        <Show when={isExpanded() && series.Drafts} keyed>
                                            {(drafts) => (
                                                <div class="bg-darius-bg px-4 py-2">
                                                    <For
                                                        each={[...drafts].sort(
                                                            (a, b) =>
                                                                (a.seriesIndex ?? 0) -
                                                                (b.seriesIndex ?? 0)
                                                        )}
                                                    >
                                                        {(draft) => (
                                                            <div
                                                                class="flex cursor-pointer items-center gap-2 rounded bg-darius-card px-2 py-2"
                                                                classList={{
                                                                    "bg-darius-purple/15":
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
                                                                <span class="text-sm text-darius-text-secondary">
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
                                                                            "text-darius-purple-bright":
                                                                                draft.winner ===
                                                                                "blue",
                                                                            "text-darius-crimson":
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
                                                                    <span class="text-xs text-darius-ember">
                                                                        Complete
                                                                    </span>
                                                                </Show>
                                                                <Show
                                                                    when={
                                                                        !draft.completed
                                                                    }
                                                                >
                                                                    <span class="text-xs text-darius-text-secondary">
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
                    class="rounded-md bg-darius-card px-4 py-2 text-sm text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                    onClick={props.onClose}
                >
                    Cancel
                </button>
                <button
                    class="rounded-md bg-darius-ember bg-darius-ember px-4 py-2 text-sm text-darius-text-primary disabled:opacity-50"
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
