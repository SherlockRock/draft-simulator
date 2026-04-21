import { Component, For, Show, createSignal } from "solid-js";
import {
    BonusDistributionMode,
    DEFAULT_RADIAL_CONFIG,
    LayoutNode,
    RadialLayoutConfig,
    layoutVariants
} from "../../utils/treeLayout";

export interface LayoutKnobPanelProps {
    config: RadialLayoutConfig;
    onConfigChange: (config: RadialLayoutConfig) => void;
    variantId: string;
    onVariantChange: (variantId: string) => void;
    frozen: boolean;
    onFreezeChange: (frozen: boolean) => void;
    viewportLocked: boolean;
    onViewportLockChange: (locked: boolean) => void;
    liveTree: LayoutNode | null;
    frozenTree: LayoutNode | null;
    onFrozenTreeChange: (tree: LayoutNode | null) => void;
}

interface SliderKnob {
    key: keyof RadialLayoutConfig;
    label: string;
    min: number;
    max: number;
    step: number;
    hint?: string;
}

const SLIDER_KNOBS: SliderKnob[] = [
    {
        key: "ringSpacingMultiplier",
        label: "Ring spacing × nodeRadius",
        min: 1,
        max: 10,
        step: 0.1,
        hint: "Radial distance per layer"
    },
    {
        key: "ringSpacingOffset",
        label: "Ring spacing offset (px)",
        min: 0,
        max: 200,
        step: 1
    },
    {
        key: "targetOccupancy",
        label: "Target occupancy",
        min: 0.4,
        max: 1,
        step: 0.01,
        hint: "How full deep layers should pack (preferred-span)"
    },
    {
        key: "spineCompressionStep",
        label: "Spine depth step",
        min: 0.2,
        max: 1,
        step: 0.05,
        hint: "Radial step for single-child chains (1 = normal)"
    },
    {
        key: "selfPadding",
        label: "Self padding (px)",
        min: 0,
        max: 40,
        step: 1
    },
    {
        key: "siblingMinChordRatio",
        label: "Sibling min chord × nodeWidth",
        min: 0,
        max: 1.5,
        step: 0.05
    },
    {
        key: "siblingMinChordFloor",
        label: "Sibling min chord floor (px)",
        min: 0,
        max: 60,
        step: 1
    },
    {
        key: "occupancyRelaxDivisor",
        label: "Occupancy relax divisor",
        min: 0.5,
        max: 10,
        step: 0.1,
        hint: "Higher = deeper layers relax slower toward 1.0"
    }
];

const STORAGE_KEY = "firstpick:navigator:layout-dev";

interface StoredSnapshot {
    name: string;
    config: RadialLayoutConfig;
    tree: LayoutNode;
}

interface StoredState {
    config: RadialLayoutConfig;
    variantId: string;
    snapshots: StoredSnapshot[];
}

export function loadStoredState(): StoredState | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredState;
        return {
            config: { ...DEFAULT_RADIAL_CONFIG, ...parsed.config },
            variantId: parsed.variantId ?? "radial",
            snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
        };
    } catch {
        return null;
    }
}

function saveStoredState(state: StoredState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // ignore quota / serialization errors
    }
}

const LayoutKnobPanel: Component<LayoutKnobPanelProps> = (props) => {
    const [open, setOpen] = createSignal(true);
    const [snapshots, setSnapshots] = createSignal<StoredSnapshot[]>(
        loadStoredState()?.snapshots ?? []
    );
    const [snapshotName, setSnapshotName] = createSignal("");
    const [copied, setCopied] = createSignal(false);

    const persist = () => {
        saveStoredState({
            config: props.config,
            variantId: props.variantId,
            snapshots: snapshots()
        });
    };

    const setKnob = (key: keyof RadialLayoutConfig, value: number) => {
        props.onConfigChange({ ...props.config, [key]: value });
        queueMicrotask(persist);
    };

    const setBonusMode = (mode: BonusDistributionMode) => {
        props.onConfigChange({ ...props.config, bonusDistributionMode: mode });
        queueMicrotask(persist);
    };

    const resetKnob = (key: keyof RadialLayoutConfig) => {
        props.onConfigChange({ ...props.config, [key]: DEFAULT_RADIAL_CONFIG[key] });
        queueMicrotask(persist);
    };

    const resetAll = () => {
        props.onConfigChange({ ...DEFAULT_RADIAL_CONFIG });
        queueMicrotask(persist);
    };

    const handleFreezeToggle = () => {
        if (props.frozen) {
            props.onFreezeChange(false);
            props.onFrozenTreeChange(null);
        } else {
            props.onFrozenTreeChange(props.liveTree);
            props.onFreezeChange(true);
        }
    };

    const handleSaveSnapshot = () => {
        const tree = props.frozen ? props.frozenTree : props.liveTree;
        if (!tree) return;
        const name = snapshotName().trim() || `snapshot-${snapshots().length + 1}`;
        const next = [
            ...snapshots().filter((s) => s.name !== name),
            { name, config: props.config, tree }
        ];
        setSnapshots(next);
        setSnapshotName("");
        queueMicrotask(persist);
    };

    const handleLoadSnapshot = (snap: StoredSnapshot) => {
        props.onConfigChange(snap.config);
        props.onFrozenTreeChange(snap.tree);
        props.onFreezeChange(true);
        queueMicrotask(persist);
    };

    const handleDeleteSnapshot = (name: string) => {
        setSnapshots(snapshots().filter((s) => s.name !== name));
        queueMicrotask(persist);
    };

    const handleCopyConfig = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(props.config, null, 4));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch {
            setCopied(false);
        }
    };

    const handleVariantChange = (value: string) => {
        props.onVariantChange(value);
        queueMicrotask(persist);
    };

    return (
        <div class="pointer-events-auto absolute bottom-4 right-4 z-20 w-80 rounded-lg border border-slate-700/80 bg-slate-950/95 text-slate-200 shadow-xl shadow-slate-950/50 backdrop-blur">
            <button
                type="button"
                class="flex w-full items-center justify-between rounded-t-lg px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300 hover:bg-slate-900/60"
                onClick={() => setOpen(!open())}
            >
                <span>Layout Dev Panel</span>
                <span class="text-slate-500">{open() ? "▾" : "▸"}</span>
            </button>
            <Show when={open()}>
                <div class="flex max-h-[70vh] flex-col gap-3 overflow-y-auto border-t border-slate-800/80 px-3 py-3 text-xs">
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                            Layout variant
                        </label>
                        <select
                            class="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 focus:border-sky-500 focus:outline-none"
                            value={props.variantId}
                            onChange={(e) => handleVariantChange(e.currentTarget.value)}
                        >
                            <For each={layoutVariants}>
                                {(variant) => (
                                    <option value={variant.id}>{variant.name}</option>
                                )}
                            </For>
                        </select>
                    </div>

                    <div class="flex flex-col gap-1">
                        <label class="flex items-center gap-2 text-[11px] text-slate-300">
                            <input
                                type="checkbox"
                                checked={props.frozen}
                                onChange={handleFreezeToggle}
                                class="h-3.5 w-3.5 accent-sky-500"
                            />
                            Freeze tree (tune against snapshot)
                        </label>
                        <Show when={props.frozen}>
                            <div class="text-[10px] text-sky-300">
                                Tree frozen — reconciliation updates ignored until
                                unfrozen.
                            </div>
                        </Show>
                        <label class="flex items-center gap-2 text-[11px] text-slate-300">
                            <input
                                type="checkbox"
                                checked={props.viewportLocked}
                                onChange={(e) =>
                                    props.onViewportLockChange(e.currentTarget.checked)
                                }
                                class="h-3.5 w-3.5 accent-sky-500"
                            />
                            Lock viewport (no auto-fit on layout change)
                        </label>
                    </div>

                    <Show when={props.variantId === "radial"}>
                        <div class="flex flex-col gap-3 border-t border-slate-800/60 pt-3">
                            <For each={SLIDER_KNOBS}>
                                {(knob) => {
                                    const value = () => props.config[knob.key] as number;
                                    const isDefault = () =>
                                        props.config[knob.key] ===
                                        DEFAULT_RADIAL_CONFIG[knob.key];
                                    return (
                                        <div class="flex flex-col gap-1">
                                            <div class="flex items-baseline justify-between gap-2">
                                                <span class="text-[11px] font-medium text-slate-300">
                                                    {knob.label}
                                                </span>
                                                <div class="flex items-center gap-2">
                                                    <span class="font-mono text-[10px] text-sky-300">
                                                        {value().toFixed(
                                                            knob.step < 1 ? 2 : 0
                                                        )}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        class="text-[9px] uppercase tracking-wide text-slate-500 hover:text-slate-300 disabled:opacity-30"
                                                        disabled={isDefault()}
                                                        onClick={() =>
                                                            resetKnob(knob.key)
                                                        }
                                                    >
                                                        reset
                                                    </button>
                                                </div>
                                            </div>
                                            <input
                                                type="range"
                                                min={knob.min}
                                                max={knob.max}
                                                step={knob.step}
                                                value={value()}
                                                onInput={(e) =>
                                                    setKnob(
                                                        knob.key,
                                                        Number(e.currentTarget.value)
                                                    )
                                                }
                                                class="accent-sky-500"
                                            />
                                            <Show when={knob.hint}>
                                                <div class="text-[10px] text-slate-500">
                                                    {knob.hint}
                                                </div>
                                            </Show>
                                        </div>
                                    );
                                }}
                            </For>
                            <div class="flex flex-col gap-1">
                                <label class="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                                    Bonus distribution
                                </label>
                                <select
                                    class="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 focus:border-sky-500 focus:outline-none"
                                    value={props.config.bonusDistributionMode}
                                    onChange={(e) =>
                                        setBonusMode(
                                            e.currentTarget.value as BonusDistributionMode
                                        )
                                    }
                                >
                                    <option value="proportional-to-deficit">
                                        proportional to deficit (default)
                                    </option>
                                    <option value="equal">equal split</option>
                                    <option value="proportional-to-min">
                                        proportional to min
                                    </option>
                                </select>
                            </div>
                        </div>
                    </Show>

                    <div class="flex flex-col gap-2 border-t border-slate-800/60 pt-3">
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                                Snapshots
                            </span>
                            <div class="flex gap-2">
                                <button
                                    type="button"
                                    onClick={resetAll}
                                    class="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                                >
                                    Reset all
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCopyConfig}
                                    class="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                                >
                                    {copied() ? "Copied!" : "Copy JSON"}
                                </button>
                            </div>
                        </div>
                        <div class="flex gap-1">
                            <input
                                type="text"
                                value={snapshotName()}
                                onInput={(e) => setSnapshotName(e.currentTarget.value)}
                                placeholder="snapshot name"
                                class="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={handleSaveSnapshot}
                                disabled={!props.liveTree && !props.frozenTree}
                                class="rounded bg-sky-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-400 disabled:opacity-30"
                            >
                                Save
                            </button>
                        </div>
                        <Show when={snapshots().length > 0}>
                            <ul class="flex flex-col gap-1">
                                <For each={snapshots()}>
                                    {(snap) => (
                                        <li class="flex items-center justify-between rounded border border-slate-800 bg-slate-900/60 px-2 py-1">
                                            <span class="truncate text-[11px] text-slate-200">
                                                {snap.name}
                                            </span>
                                            <div class="flex gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleLoadSnapshot(snap)
                                                    }
                                                    class="text-[10px] text-sky-300 hover:text-sky-200"
                                                >
                                                    load
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleDeleteSnapshot(snap.name)
                                                    }
                                                    class="text-[10px] text-rose-300 hover:text-rose-200"
                                                >
                                                    delete
                                                </button>
                                            </div>
                                        </li>
                                    )}
                                </For>
                            </ul>
                        </Show>
                    </div>
                </div>
            </Show>
        </div>
    );
};

export default LayoutKnobPanel;
