import {
    Accessor,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    untrack
} from "solid-js";
import { ChevronDown, ChevronUp, X } from "lucide-solid";
import { SearchableSelect } from "./SearchableSelect";
import { champions } from "../utils/constants";
import type { SearchBucket, SearchResults } from "../utils/canvasSearch";

const BUCKET_ORDER: SearchBucket[] = [
    "pickedBy",
    "pickedAgainst",
    "bannedBy",
    "bannedAgainst"
];

const BUCKET_LABELS: Record<SearchBucket, string> = {
    pickedBy: "Picked by",
    pickedAgainst: "Picked vs",
    bannedBy: "Banned by",
    bannedAgainst: "Banned vs"
};

const PICK_BUCKETS: SearchBucket[] = ["pickedBy", "pickedAgainst"];

type CanvasSearchBarProps = {
    championId: Accessor<string | null>;
    onChampionChange: (championId: string | null) => void;
    teamName: Accessor<string | null>;
    onTeamChange: (teamName: string | null) => void;
    teamOptions: Accessor<string[]>;
    activeBucket: Accessor<SearchBucket | null>;
    onBucketChange: (bucket: SearchBucket | null) => void;
    results: Accessor<SearchResults | null>;
    currentIndex: Accessor<number>;
    onNavigate: (direction: 1 | -1) => void;
    onClose: () => void;
    focusNonce: Accessor<number>;
};

export const CanvasSearchBar = (props: CanvasSearchBarProps) => {
    let rootRef: HTMLDivElement | undefined;
    const championNames = champions.map((champion) => champion.name);

    const initialChampionName = () => {
        const id = props.championId();
        if (id === null) return "";
        return champions.find((champion) => champion.id === id)?.name ?? "";
    };
    const [championText, setChampionText] = createSignal(initialChampionName());
    const [teamText, setTeamText] = createSignal(untrack(() => props.teamName() ?? ""));

    createEffect(() => {
        props.focusNonce();
        const input = rootRef?.querySelector("input");
        input?.focus();
        input?.select();
    });

    const matchCount = createMemo(() => props.results()?.matches.length ?? 0);
    const counterText = createMemo(() => {
        const count = matchCount();
        if (count === 0) return props.championId() ? "0 / 0" : "";
        return `${Math.min(props.currentIndex() + 1, count)} / ${count}`;
    });

    const handleChampionText = (value: string) => {
        setChampionText(value);
        if (value.trim() === "") props.onChampionChange(null);
    };

    const handleChampionSelect = (name: string) => {
        const champion = champions.find((entry) => entry.name === name);
        props.onChampionChange(champion ? champion.id : null);
    };

    const handleTeamText = (value: string) => {
        setTeamText(value);
        if (value.trim() === "") props.onTeamChange(null);
    };

    const handleKeyDownCapture = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (
            e.key === "Enter" &&
            !e.defaultPrevented &&
            !(e.target instanceof HTMLButtonElement) &&
            props.championId() !== null
        ) {
            e.preventDefault();
            e.stopPropagation();
            props.onNavigate(e.shiftKey ? -1 : 1);
        }
    };

    return (
        <div
            ref={rootRef}
            data-canvas-search-bar="true"
            class="fixed left-1/2 top-20 z-50 flex -translate-x-1/2 select-text flex-col gap-2 rounded-xl border border-darius-border bg-darius-card/95 p-3 shadow-[0_16px_40px_rgba(15,23,42,0.6)] backdrop-blur-sm"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            onKeyDownCapture={handleKeyDownCapture}
        >
            <div class="flex items-center gap-2">
                <div class="w-52">
                    <SearchableSelect
                        placeholder="Champion…"
                        currentlySelected={initialChampionName()}
                        sortOptions={championNames}
                        selectText={championText()}
                        setSelectText={handleChampionText}
                        onValidSelect={handleChampionSelect}
                        theme="purple"
                        textInput={true}
                    />
                </div>
                <div class="w-44">
                    <SearchableSelect
                        placeholder="Team (optional)"
                        currentlySelected={props.teamName() ?? ""}
                        sortOptions={props.teamOptions()}
                        selectText={teamText()}
                        setSelectText={handleTeamText}
                        onValidSelect={(name) => props.onTeamChange(name)}
                        theme="purple"
                        textInput={true}
                    />
                </div>
                <span class="min-w-[3.5rem] text-center text-sm tabular-nums text-darius-text-secondary">
                    {counterText()}
                </span>
                <button
                    type="button"
                    onClick={() => props.onNavigate(-1)}
                    disabled={matchCount() === 0}
                    class="flex size-7 items-center justify-center rounded-lg border border-darius-border text-darius-text-secondary transition-colors hover:border-darius-purple-bright/60 hover:text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Previous match"
                >
                    <ChevronUp size={16} />
                </button>
                <button
                    type="button"
                    onClick={() => props.onNavigate(1)}
                    disabled={matchCount() === 0}
                    class="flex size-7 items-center justify-center rounded-lg border border-darius-border text-darius-text-secondary transition-colors hover:border-darius-purple-bright/60 hover:text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Next match"
                >
                    <ChevronDown size={16} />
                </button>
                <button
                    type="button"
                    onClick={() => props.onClose()}
                    class="flex size-7 items-center justify-center rounded-lg text-darius-text-secondary transition-colors hover:text-darius-crimson"
                    aria-label="Close search"
                >
                    <X size={16} />
                </button>
            </div>

            <Show when={props.results()?.buckets}>
                {(buckets) => (
                    <div class="flex flex-wrap items-center gap-1.5">
                        <For each={BUCKET_ORDER}>
                            {(bucket) => (
                                <button
                                    type="button"
                                    onClick={() =>
                                        props.onBucketChange(
                                            props.activeBucket() === bucket
                                                ? null
                                                : bucket
                                        )
                                    }
                                    class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                                    classList={{
                                        "border-darius-purple-bright bg-darius-purple/25 text-darius-text-primary":
                                            props.activeBucket() === bucket,
                                        "border-darius-border bg-darius-card text-darius-text-secondary hover:border-darius-purple-bright/60":
                                            props.activeBucket() !== bucket
                                    }}
                                >
                                    {BUCKET_LABELS[bucket]}{" "}
                                    <span class="font-semibold">
                                        {buckets()[bucket].games}
                                    </span>
                                    <Show when={PICK_BUCKETS.includes(bucket)}>
                                        <span class="ml-1 opacity-80">
                                            {buckets()[bucket].wins}W-
                                            {buckets()[bucket].losses}L
                                        </span>
                                    </Show>
                                    <Show when={buckets()[bucket].noResult > 0}>
                                        <span class="ml-1 opacity-60">
                                            {buckets()[bucket].noResult} no result
                                        </span>
                                    </Show>
                                    <Show when={buckets()[bucket].inProgress > 0}>
                                        <span class="ml-1 text-darius-ember">
                                            {buckets()[bucket].inProgress} in progress
                                        </span>
                                    </Show>
                                </button>
                            )}
                        </For>
                    </div>
                )}
            </Show>
        </div>
    );
};
