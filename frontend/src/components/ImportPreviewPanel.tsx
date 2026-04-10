import { Component, createMemo, For, Show } from "solid-js";
import { z } from "zod";
import { Clipboard } from "lucide-solid";
import { CanvasJsonImportDataSchema, DedupeStrategySchema } from "../utils/schemas";
import { getSplashUrl } from "../utils/constants";

type CanvasJsonImportData = z.infer<typeof CanvasJsonImportDataSchema>;
type DedupeStrategy = z.infer<typeof DedupeStrategySchema>;

type ParsedResult =
    | { status: "empty" }
    | { status: "invalid"; error: string }
    | { status: "valid"; data: CanvasJsonImportData };

type Props = {
    parsedData: ParsedResult;
    checkedItems: Map<string, boolean>;
    setCheckedItems: (key: string, checked: boolean) => void;
    existingDraftNames: string[];
    existingGroupNames: string[];
    dedupeStrategy: DedupeStrategy;
    setDedupeStrategy: (s: DedupeStrategy) => void;
};

const PickSlot: Component<{ champion: string; isBan: boolean }> = (props) => {
    return (
        <Show
            when={props.champion}
            fallback={
                <div class="h-10 w-10 flex-shrink-0 rounded border border-dashed border-darius-text-secondary/40 bg-darius-card" />
            }
        >
            <div
                class="h-10 w-10 flex-shrink-0 overflow-hidden rounded"
                classList={{
                    "border-[1.5px] border-red-500": props.isBan,
                    "border-[1.5px] border-darius-ember": !props.isBan
                }}
            >
                <img
                    src={getSplashUrl(props.champion)}
                    alt={props.champion}
                    title={props.champion}
                    class="h-full w-full object-cover"
                />
            </div>
        </Show>
    );
};

const PicksRow: Component<{
    picks: string[];
    side: "blue" | "red";
}> = (props) => {
    const bans = () =>
        props.side === "blue" ? props.picks.slice(0, 5) : props.picks.slice(5, 10);
    const selections = () =>
        props.side === "blue" ? props.picks.slice(10, 15) : props.picks.slice(15, 20);

    return (
        <div class="custom-scrollbar flex items-center gap-1.5 overflow-x-auto pb-px">
            <span
                class="w-7 flex-shrink-0 text-[0.5625rem] font-semibold uppercase tracking-wide"
                classList={{
                    "text-blue-400": props.side === "blue",
                    "text-darius-crimson": props.side === "red"
                }}
            >
                {props.side === "blue" ? "Blue" : "Red"}
            </span>
            <div class="flex gap-[0.15rem]">
                <For each={bans()}>
                    {(champ) => <PickSlot champion={champ} isBan={true} />}
                </For>
            </div>
            <div class="w-1" />
            <div class="flex gap-[0.15rem]">
                <For each={selections()}>
                    {(champ) => <PickSlot champion={champ} isBan={false} />}
                </For>
            </div>
        </div>
    );
};

const GamePreviewBlock: Component<{
    picks: string[];
    gameNumber: number;
    winner?: "blue" | "red" | null;
}> = (props) => (
    <div class="rounded-md border border-darius-border/70 bg-darius-bg/50 p-2">
        <div class="mb-1.5 flex items-center justify-between gap-2">
            <span class="text-[0.6875rem] font-semibold text-darius-text-primary">
                Game {props.gameNumber}
            </span>
            <Show
                when={props.winner}
                fallback={
                    <span class="rounded bg-darius-text-secondary/15 px-1.5 py-px text-[0.5625rem] font-medium text-darius-text-secondary">
                        Incomplete
                    </span>
                }
            >
                <span
                    class="rounded px-1.5 py-px text-[0.5625rem] font-medium capitalize"
                    classList={{
                        "bg-blue-500/20 text-blue-400": props.winner === "blue",
                        "bg-darius-crimson/20 text-darius-crimson": props.winner === "red"
                    }}
                >
                    {props.winner} win
                </span>
            </Show>
        </div>
        <div class="flex flex-col gap-1">
            <PicksRow picks={props.picks} side="blue" />
            <PicksRow picks={props.picks} side="red" />
        </div>
    </div>
);

const DraftPreviewRows: Component<{ picks: string[] }> = (props) => (
    <div class="flex flex-col gap-1">
        <PicksRow picks={props.picks} side="blue" />
        <PicksRow picks={props.picks} side="red" />
    </div>
);

export const ImportPreviewPanel: Component<Props> = (props) => {
    const data = () =>
        props.parsedData.status === "valid" ? props.parsedData.data : null;

    const conflicts = createMemo(() => {
        const d = data();
        if (!d) return [];
        const conflicting: string[] = [];

        d.drafts.forEach((draft, i) => {
            const key = `draft-${i}`;
            if (
                props.checkedItems.get(key) !== false &&
                props.existingDraftNames.includes(draft.name)
            ) {
                conflicting.push(draft.name);
            }
        });

        d.versusSeries.forEach((series, i) => {
            const key = `series-${i}`;
            const seriesName = series.name ?? `Series ${i + 1}`;
            if (
                props.checkedItems.get(key) !== false &&
                props.existingGroupNames.includes(seriesName)
            ) {
                conflicting.push(seriesName);
            }
        });

        return conflicting;
    });

    return (
        <div class="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
            <Show when={props.parsedData.status === "empty"}>
                <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-darius-border text-[0.8125rem] text-darius-text-secondary/60">
                    <Clipboard size={32} class="opacity-30" />
                    Paste JSON to see a preview
                </div>
            </Show>

            <Show when={props.parsedData.status === "invalid"}>
                <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-red-500/40 text-[0.8125rem] text-red-300">
                    <span class="text-red-400">
                        {props.parsedData.status === "invalid"
                            ? props.parsedData.error
                            : ""}
                    </span>
                </div>
            </Show>

            <Show when={data()}>
                {(validData) => (
                    <div class="flex flex-col gap-1">
                        {/* Standalone drafts */}
                        <Show when={validData().drafts.length > 0}>
                            <div class="text-xs font-semibold uppercase tracking-wide text-darius-text-secondary">
                                Drafts ({validData().drafts.length})
                            </div>
                            <For each={validData().drafts}>
                                {(draft, i) => {
                                    const key = () => `draft-${i()}`;
                                    const isChecked = () =>
                                        props.checkedItems.get(key()) !== false;
                                    const hasConflict = () =>
                                        props.existingDraftNames.includes(draft.name);

                                    return (
                                        <div class="rounded-lg border border-darius-border bg-darius-card p-2.5 transition-opacity duration-150">
                                            <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
                                                <input
                                                    type="checkbox"
                                                    checked={isChecked()}
                                                    onChange={(e) =>
                                                        props.setCheckedItems(
                                                            key(),
                                                            e.currentTarget.checked
                                                        )
                                                    }
                                                    class="h-3.5 w-3.5 accent-darius-purple"
                                                />
                                                <span class="text-[0.8125rem] font-semibold text-darius-text-primary">
                                                    {draft.name}
                                                </span>
                                                <Show when={hasConflict()}>
                                                    <span class="inline-flex items-center gap-1 rounded-full bg-amber-900 px-1.5 py-px text-[0.625rem] font-medium text-amber-300">
                                                        ⚠ Conflict
                                                    </span>
                                                </Show>
                                            </div>
                                            <DraftPreviewRows picks={draft.picks} />
                                        </div>
                                    );
                                }}
                            </For>
                        </Show>

                        {/* Versus series */}
                        <Show when={validData().versusSeries.length > 0}>
                            <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-darius-text-secondary">
                                Versus Series ({validData().versusSeries.length})
                            </div>
                            <For each={validData().versusSeries}>
                                {(series, i) => {
                                    const key = () => `series-${i()}`;
                                    const isChecked = () =>
                                        props.checkedItems.get(key()) !== false;
                                    const seriesName = () =>
                                        series.name ?? `Series ${i() + 1}`;
                                    const hasConflict = () =>
                                        props.existingGroupNames.includes(seriesName());

                                    return (
                                        <div class="rounded-lg border border-darius-border bg-darius-card p-2.5 transition-opacity duration-150">
                                            <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
                                                <input
                                                    type="checkbox"
                                                    checked={isChecked()}
                                                    onChange={(e) =>
                                                        props.setCheckedItems(
                                                            key(),
                                                            e.currentTarget.checked
                                                        )
                                                    }
                                                    class="h-3.5 w-3.5 accent-darius-purple"
                                                />
                                                <span class="text-[0.8125rem] font-semibold text-darius-text-primary">
                                                    {seriesName()}
                                                </span>
                                                <Show when={hasConflict()}>
                                                    <span class="inline-flex items-center gap-1 rounded-full bg-amber-900 px-1.5 py-px text-[0.625rem] font-medium text-amber-300">
                                                        ⚠ Conflict
                                                    </span>
                                                </Show>
                                                <span class="flex items-center gap-1 text-[0.625rem] text-darius-text-secondary">
                                                    <span class="rounded bg-darius-text-secondary/15 px-1.5 py-px text-[0.5625rem] font-medium">
                                                        Bo{series.seriesLength}
                                                    </span>
                                                    <Show
                                                        when={
                                                            series.draftType &&
                                                            series.draftType !==
                                                                "standard"
                                                        }
                                                    >
                                                        <span class="rounded bg-darius-crimson/20 px-1.5 py-px text-[0.5625rem] font-medium capitalize text-darius-crimson">
                                                            {series.draftType}
                                                        </span>
                                                    </Show>
                                                    <span>
                                                        · {series.drafts.length} game
                                                        {series.drafts.length !== 1
                                                            ? "s"
                                                            : ""}
                                                    </span>
                                                </span>
                                            </div>

                                            <div class="flex flex-col gap-2">
                                                <For each={series.drafts}>
                                                    {(game, gi) => (
                                                        <GamePreviewBlock
                                                            picks={game.picks}
                                                            gameNumber={
                                                                game.gameNumber ??
                                                                gi() + 1
                                                            }
                                                            winner={game.winner}
                                                        />
                                                    )}
                                                </For>
                                            </div>
                                        </div>
                                    );
                                }}
                            </For>
                        </Show>

                        {/* Conflict section */}
                        <Show when={conflicts().length > 0}>
                            <div class="mt-3 rounded-lg border border-amber-900 bg-amber-950/50 p-2.5">
                                <h4 class="text-xs font-semibold text-amber-300">
                                    ⚠ {conflicts().length} name conflict
                                    {conflicts().length !== 1 ? "s" : ""}
                                </h4>
                                <p class="mt-1 text-[0.6875rem] text-darius-text-secondary">
                                    {conflicts()
                                        .map((n) => `"${n}"`)
                                        .join(", ")}{" "}
                                    already exist
                                    {conflicts().length === 1 ? "s" : ""} on this canvas.
                                </p>
                                <div class="mt-2 flex gap-3">
                                    <For each={["rename", "skip", "overwrite"] as const}>
                                        {(option) => (
                                            <label class="flex cursor-pointer items-center gap-1 text-xs text-darius-text-primary">
                                                <input
                                                    type="radio"
                                                    name="dedupe-strategy"
                                                    checked={
                                                        props.dedupeStrategy === option
                                                    }
                                                    onChange={() =>
                                                        props.setDedupeStrategy(option)
                                                    }
                                                    class="accent-darius-purple"
                                                />
                                                <span class="capitalize">{option}</span>
                                            </label>
                                        )}
                                    </For>
                                </div>
                            </div>
                        </Show>
                    </div>
                )}
            </Show>
        </div>
    );
};
