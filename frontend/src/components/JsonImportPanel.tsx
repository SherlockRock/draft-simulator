import { Component, createMemo, createSignal, Show } from "solid-js";
import { createMutation } from "@tanstack/solid-query";
import { z } from "zod";
import toast from "solid-toast";
import { CanvasJsonImportDataSchema, DedupeStrategySchema } from "../utils/schemas";
import { importJsonToCanvas } from "../utils/actions";
import { SchemaReferencePanel } from "./SchemaReferencePanel";
import { ImportPreviewPanel } from "./ImportPreviewPanel";

type CanvasJsonImportData = z.infer<typeof CanvasJsonImportDataSchema>;
type DedupeStrategy = z.infer<typeof DedupeStrategySchema>;

type Props = {
    canvasId: string;
    positionX: number;
    positionY: number;
    existingDraftNames: string[];
    existingGroupNames: string[];
    onClose: () => void;
    onSuccess: () => void;
};

const formatSchemaError = (error: z.ZodError) => {
    const issue = error.issues[0];
    if (!issue) return "Invalid JSON import payload.";
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
};

const buildImportSummary = (result: {
    summary: {
        draftsCreated: number;
        draftsUpdated: number;
        draftsSkipped: number;
        seriesCreated: number;
        seriesUpdated: number;
        seriesSkipped: number;
    };
}) => {
    const parts: string[] = [];
    const s = result.summary;
    if (s.draftsCreated > 0) parts.push(`${s.draftsCreated} drafts created`);
    if (s.draftsUpdated > 0) parts.push(`${s.draftsUpdated} drafts updated`);
    if (s.draftsSkipped > 0) parts.push(`${s.draftsSkipped} drafts skipped`);
    if (s.seriesCreated > 0) parts.push(`${s.seriesCreated} series created`);
    if (s.seriesUpdated > 0) parts.push(`${s.seriesUpdated} series updated`);
    if (s.seriesSkipped > 0) parts.push(`${s.seriesSkipped} series skipped`);
    return parts;
};

export const JsonImportPanel: Component<Props> = (props) => {
    const [jsonInput, setJsonInput] = createSignal("");
    const [dedupeStrategy, setDedupeStrategy] = createSignal<DedupeStrategy>("rename");
    const [checkedItems, setCheckedItemsRaw] = createSignal<Map<string, boolean>>(
        new Map()
    );

    const setCheckedItem = (key: string, checked: boolean) => {
        const next = new Map(checkedItems());
        next.set(key, checked);
        setCheckedItemsRaw(next);
    };

    const isChecked = (items: Map<string, boolean>, key: string) =>
        items.get(key) !== false;

    const parsedJsonImport = createMemo<
        | { status: "empty" }
        | { status: "invalid"; error: string }
        | { status: "valid"; data: CanvasJsonImportData }
    >(() => {
        const input = jsonInput().trim();
        if (!input) return { status: "empty" };

        try {
            const parsed = JSON.parse(input);
            const validated = CanvasJsonImportDataSchema.safeParse(parsed);

            if (!validated.success) {
                return {
                    status: "invalid",
                    error: formatSchemaError(validated.error)
                };
            }

            return { status: "valid", data: validated.data };
        } catch (error) {
            return {
                status: "invalid",
                error:
                    error instanceof Error ? error.message : "Unable to parse JSON input."
            };
        }
    });

    const importableItemCount = createMemo(() => {
        const parsed = parsedJsonImport();
        if (parsed.status !== "valid") return 0;
        const items = checkedItems();
        const skipConflicts = dedupeStrategy() === "skip";
        let count = 0;

        parsed.data.drafts.forEach((draft, i) => {
            if (!isChecked(items, `draft-${i}`)) return;
            if (skipConflicts && props.existingDraftNames.includes(draft.name)) {
                return;
            }
            count++;
        });
        parsed.data.versusSeries.forEach((series, i) => {
            if (!isChecked(items, `series-${i}`)) return;
            const seriesName = series.name ?? `Series ${i + 1}`;
            if (skipConflicts && props.existingGroupNames.includes(seriesName)) {
                return;
            }
            count++;
        });

        return count;
    });

    const importJsonMutation = createMutation(() => ({
        mutationFn: importJsonToCanvas,
        onSuccess: (result: Awaited<ReturnType<typeof importJsonToCanvas>>) => {
            const parts = buildImportSummary(result);
            toast.success(
                parts[0] ? `Import complete: ${parts.join(", ")}` : "Import complete"
            );

            for (const warning of result.warnings) {
                toast(warning, { icon: "!" });
            }

            props.onSuccess();
            props.onClose();
        },
        onError: (error: Error) => {
            toast.error(error.message || "Import failed");
        }
    }));

    const submitImport = () => {
        const parsed = parsedJsonImport();
        if (parsed.status !== "valid") return;
        if (importableItemCount() === 0) return;

        const items = checkedItems();
        const filteredDrafts = parsed.data.drafts.filter(
            (draft, i) =>
                isChecked(items, `draft-${i}`) &&
                !(
                    dedupeStrategy() === "skip" &&
                    props.existingDraftNames.includes(draft.name)
                )
        );
        const filteredSeries = parsed.data.versusSeries.filter((series, i) => {
            const seriesName = series.name ?? `Series ${i + 1}`;
            return (
                isChecked(items, `series-${i}`) &&
                !(
                    dedupeStrategy() === "skip" &&
                    props.existingGroupNames.includes(seriesName)
                )
            );
        });

        if (filteredDrafts.length === 0 && filteredSeries.length === 0) return;

        importJsonMutation.mutate({
            canvasId: props.canvasId,
            data: {
                drafts: filteredDrafts,
                versusSeries: filteredSeries
            },
            options: {
                dedupeStrategy: dedupeStrategy(),
                basePositionX: props.positionX,
                basePositionY: props.positionY
            }
        });
    };

    const canSubmit = () =>
        parsedJsonImport().status === "valid" && importableItemCount() > 0;

    const buttonLabel = () => {
        if (importJsonMutation.isPending) return "Importing...";
        const count = importableItemCount();
        if (count > 0) return `Import ${count} item${count !== 1 ? "s" : ""}`;
        return "Import JSON";
    };

    const validationStatus = createMemo(() => {
        const parsed = parsedJsonImport();
        if (parsed.status !== "valid") return null;
        const d = parsed.data;
        const parts: string[] = [];
        if (d.drafts.length > 0)
            parts.push(`${d.drafts.length} draft${d.drafts.length !== 1 ? "s" : ""}`);
        if (d.versusSeries.length > 0)
            parts.push(`${d.versusSeries.length} versus series`);
        return `\u2713 ${parts.join(", ")}`;
    });

    const validationError = createMemo(() => {
        const parsed = parsedJsonImport();
        return parsed.status === "invalid" ? parsed.error : null;
    });

    return (
        <div class="flex max-h-[31.5rem] min-h-[31.5rem] flex-col gap-4">
            <div
                class="grid gap-4"
                style={{ "grid-template-columns": "min(20rem, 25%) 1fr 1fr" }}
            >
                {/* Left: Schema Reference */}
                <div class="flex max-h-[28rem] min-h-[28rem] flex-col">
                    <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-darius-text-secondary">
                        Reference
                    </div>
                    <SchemaReferencePanel />
                </div>

                {/* Middle: JSON Input */}
                <div class="flex max-h-[28rem] min-h-[28rem] flex-col">
                    <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-darius-text-secondary">
                        JSON Input
                    </div>
                    <textarea
                        value={jsonInput()}
                        onInput={(e) => setJsonInput(e.currentTarget.value)}
                        spellcheck={false}
                        placeholder='{ "drafts": [], "versusSeries": [] }'
                        class="custom-scrollbar flex-1 resize-none rounded-lg border border-darius-border bg-darius-bg px-3 py-3 font-mono text-xs leading-relaxed text-darius-text-primary placeholder:text-darius-text-secondary focus:border-darius-purple-bright focus:outline-none focus:ring-2 focus:ring-darius-purple/40"
                    />
                    <Show when={validationStatus()}>
                        <div class="mt-2 flex items-center gap-1 text-[0.8125rem] text-green-400">
                            {validationStatus()}
                        </div>
                    </Show>
                    <Show when={validationError()}>
                        <div class="mt-2 text-[0.8125rem] text-darius-text-secondary/60">
                            {validationError()}
                        </div>
                    </Show>
                    <Show when={!validationStatus() && !validationError()}>
                        <div class="mt-2 text-[0.8125rem] text-darius-text-secondary/60">
                            Paste JSON to get started
                        </div>
                    </Show>
                </div>

                {/* Right: Preview */}
                <div class="flex max-h-[28rem] min-h-[28rem] flex-col">
                    <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-darius-text-secondary">
                        Preview
                    </div>
                    <ImportPreviewPanel
                        parsedData={parsedJsonImport()}
                        checkedItems={checkedItems()}
                        setCheckedItems={setCheckedItem}
                        existingDraftNames={props.existingDraftNames}
                        existingGroupNames={props.existingGroupNames}
                        dedupeStrategy={dedupeStrategy()}
                        setDedupeStrategy={setDedupeStrategy}
                    />
                </div>
            </div>

            {/* Footer */}
            <div class="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={props.onClose}
                    class="rounded-md bg-darius-card px-4 py-2 text-sm text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={submitImport}
                    disabled={!canSubmit() || importJsonMutation.isPending}
                    class="rounded-md bg-darius-purple px-4 py-2 text-sm text-darius-text-primary transition-colors hover:bg-darius-purple-bright disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-darius-purple"
                >
                    {buttonLabel()}
                </button>
            </div>
        </div>
    );
};
