import { Component, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import toast from "solid-toast";
import { Download } from "lucide-solid";
import {
    PoolJsonImportSchema,
    type RolePoolMap,
    type SavedPool
} from "@draft-sim/shared-types";
import { Dialog } from "../Dialog";
import { resolveChampionNames } from "../../utils/championNameResolver";
import {
    POOL_JSON_TEMPLATE,
    downloadPoolJsonTemplate
} from "../../utils/poolJsonTemplate";
import { createSavedPool } from "../../utils/savedPoolsApi";
import { ROLE_LABELS, ROLES } from "../../utils/championRoles";
import type { Role } from "@draft-sim/shared-types";

interface JsonImportDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    teamLabel: string;
    // If provided, the "Apply to this team" buttons are enabled and call this
    // callback with the resolved RolePoolMap. If absent, only "Save as
    // SavedPool" is enabled (e.g. no team context, import-from-dashboard).
    onApply?: (champions: RolePoolMap) => void;
    onSaved?: (pool: SavedPool) => void;
}

interface PreviewState {
    name: string;
    champions: RolePoolMap;
    unresolved: string[];
}

export const JsonImportDialog: Component<JsonImportDialogProps> = (props) => {
    const [text, setText] = createSignal("");
    const [parseError, setParseError] = createSignal<string | null>(null);
    const [preview, setPreview] = createSignal<PreviewState | null>(null);
    const [isSaving, setIsSaving] = createSignal(false);

    createEffect(() => {
        if (props.isOpen()) {
            setText("");
            setParseError(null);
            setPreview(null);
        }
    });

    const handlePreview = () => {
        setParseError(null);
        setPreview(null);
        const raw = text().trim();
        if (raw.length === 0) {
            setParseError("Paste JSON to preview");
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            setParseError(
                `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
        }
        const validation = PoolJsonImportSchema.safeParse(parsed);
        if (!validation.success) {
            const issue = validation.error.issues[0];
            const path = issue.path.join(".") || "root";
            setParseError(`${path}: ${issue.message}`);
            return;
        }
        const input = validation.data;
        const resolvedMap: RolePoolMap = {
            top: [],
            jungle: [],
            mid: [],
            adc: [],
            support: []
        };
        const allUnresolved: string[] = [];
        for (const role of ROLES) {
            const { resolved, unresolved } = resolveChampionNames(
                input.champions[role]
            );
            resolvedMap[role] = Array.from(new Set(resolved));
            for (const u of unresolved) allUnresolved.push(`${role}:${u}`);
        }
        setPreview({
            name: input.name ?? "",
            champions: resolvedMap,
            unresolved: allUnresolved
        });
    };

    const applyToTeam = () => {
        const p = preview();
        if (!p || !props.onApply) return;
        props.onApply(p.champions);
        toast.success(`Applied pool to ${props.teamLabel}`);
        props.onClose();
    };

    const saveOnly = async () => {
        const p = preview();
        if (!p) return;
        const proposedName = p.name.trim() || `Imported ${new Date().toISOString().slice(0, 10)}`;
        setIsSaving(true);
        try {
            const created = await createSavedPool({
                name: proposedName.slice(0, 120),
                champions: p.champions
            });
            toast.success(`Saved pool "${created.name}"`);
            props.onSaved?.(created);
            props.onClose();
        } catch {
            toast.error("Failed to save pool");
        } finally {
            setIsSaving(false);
        }
    };

    const saveAndApply = async () => {
        const p = preview();
        if (!p || !props.onApply) return;
        const proposedName = p.name.trim() || `Imported ${new Date().toISOString().slice(0, 10)}`;
        setIsSaving(true);
        try {
            const created = await createSavedPool({
                name: proposedName.slice(0, 120),
                champions: p.champions
            });
            props.onSaved?.(created);
            props.onApply(p.champions);
            toast.success(`Saved and applied to ${props.teamLabel}`);
            props.onClose();
        } catch {
            toast.error("Failed to save pool");
        } finally {
            setIsSaving(false);
        }
    };

    const totalResolved = createMemo(() => {
        const p = preview();
        if (!p) return 0;
        return ROLES.reduce((sum, r) => sum + p.champions[r].length, 0);
    });

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="flex w-[560px] max-w-[90vw] flex-col gap-4">
                    <div class="flex items-center justify-between">
                        <h2 class="text-xl font-bold text-darius-text-primary">
                            Import pool JSON — {props.teamLabel}
                        </h2>
                        <button
                            type="button"
                            onClick={downloadPoolJsonTemplate}
                            class="flex items-center gap-1 text-xs text-slate-300 underline hover:text-slate-100"
                        >
                            <Download size={12} />
                            Download template
                        </button>
                    </div>

                    <label class="block">
                        <span class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            JSON
                        </span>
                        <textarea
                            value={text()}
                            onInput={(e) => {
                                setText(e.currentTarget.value);
                                if (parseError()) setParseError(null);
                                if (preview()) setPreview(null);
                            }}
                            placeholder={POOL_JSON_TEMPLATE}
                            rows={10}
                            spellcheck={false}
                            class="w-full resize-y rounded border border-darius-border bg-darius-card px-3 py-2 font-mono text-xs text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright"
                        />
                    </label>

                    <Show when={parseError()}>
                        <div class="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                            {parseError()}
                        </div>
                    </Show>

                    <Show when={preview()}>
                        {(p) => (
                            <div class="flex flex-col gap-2 rounded border border-slate-700 bg-slate-900/60 p-3 text-xs">
                                <div class="flex items-baseline justify-between">
                                    <span class="text-sm font-semibold text-slate-100">
                                        Preview
                                    </span>
                                    <span class="text-slate-400">
                                        {totalResolved()} resolved
                                        {p().unresolved.length > 0
                                            ? ` · ${p().unresolved.length} unresolved`
                                            : ""}
                                    </span>
                                </div>
                                <div class="grid grid-cols-5 gap-2">
                                    <For each={ROLES}>
                                        {(role: Role) => (
                                            <div class="rounded bg-slate-900 px-2 py-1">
                                                <div class="text-slate-300">
                                                    {ROLE_LABELS[role]}
                                                </div>
                                                <div class="text-slate-500">
                                                    {p().champions[role].length}
                                                </div>
                                            </div>
                                        )}
                                    </For>
                                </div>
                                <Show when={p().unresolved.length > 0}>
                                    <div class="mt-1 rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-yellow-200">
                                        Unresolved names will be dropped:{" "}
                                        {p().unresolved.slice(0, 8).join(", ")}
                                        {p().unresolved.length > 8
                                            ? ` …+${p().unresolved.length - 8}`
                                            : ""}
                                    </div>
                                </Show>
                            </div>
                        )}
                    </Show>

                    <div class="flex flex-wrap items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="rounded-md bg-darius-card px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                        >
                            Cancel
                        </button>
                        <Show
                            when={preview()}
                            fallback={
                                <button
                                    type="button"
                                    onClick={handlePreview}
                                    class="rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary"
                                >
                                    Preview
                                </button>
                            }
                        >
                            <button
                                type="button"
                                onClick={saveOnly}
                                disabled={isSaving()}
                                class="rounded-md border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Save as SavedPool
                            </button>
                            <Show when={props.onApply}>
                                <button
                                    type="button"
                                    onClick={applyToTeam}
                                    disabled={isSaving()}
                                    class="rounded-md border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Apply to this team
                                </button>
                                <button
                                    type="button"
                                    onClick={saveAndApply}
                                    disabled={isSaving()}
                                    class="rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {isSaving() ? "Saving…" : "Save and apply"}
                                </button>
                            </Show>
                        </Show>
                    </div>
                </div>
            }
        />
    );
};
