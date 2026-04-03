import {
    Component,
    JSX,
    Show,
    createEffect,
    createSignal,
    For,
    onCleanup
} from "solid-js";
import {
    Plus,
    Minus,
    Import,
    GitBranch,
    Settings,
    Share2,
    LayoutDashboard,
    Rows3,
    X
} from "lucide-solid";
import { IconDisplay } from "./IconDisplay";
import { champions } from "../utils/constants";
import { layoutOptions } from "../utils/canvasCardLayout";
import type { CardLayout } from "../utils/canvasCardLayout";
import { layoutIconMap } from "./LayoutIcons";

interface CanvasSidebarProps {
    icon?: string | null;
    name?: string;
    description?: string | null;
    onZoomIn: () => void;
    onZoomOut: () => void;
    cardLayout: CardLayout;
    onSelectCardLayout: (layout: CardLayout) => void;
    onImport: () => void;
    isConnectionMode: boolean;
    onToggleConnectionMode: () => void;
    hasEditPermissions: boolean;
    hasAdminPermissions: boolean;
    onSettings?: () => void;
    onShare?: () => void;
    setShareButtonRef?: (el: HTMLDivElement) => void;
    sharePopperContent?: JSX.Element;
}

interface SidebarButtonProps {
    icon: Component<{ size?: number; class?: string }>;
    tooltip: string;
    onClick: () => void;
    isActive?: boolean;
    disabled?: boolean;
}

const SidebarButton: Component<SidebarButtonProps> = (props) => {
    return (
        <div class="group relative">
            <button
                onClick={props.onClick}
                disabled={props.disabled}
                aria-label={props.tooltip}
                class="flex h-9 w-9 items-center justify-center rounded-md border border-slate-600 transition-colors"
                classList={{
                    "border-purple-500 bg-purple-600 hover:bg-purple-500": props.isActive,
                    "bg-slate-800 hover:bg-slate-700": !props.isActive,
                    "cursor-not-allowed opacity-50": props.disabled
                }}
            >
                <props.icon size={18} class="text-slate-200" />
            </button>
            <div class="pointer-events-none absolute left-full top-1/2 z-[60] ml-2 -translate-y-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                {props.tooltip}
            </div>
        </div>
    );
};

const SidebarGroup: Component<{ children: JSX.Element }> = (props) => (
    <div class="flex flex-col gap-1 rounded-lg border border-slate-600 bg-slate-800 p-1.5">
        {props.children}
    </div>
);

const CanvasSidebar: Component<CanvasSidebarProps> = (props) => {
    const [isLayoutPopoverOpen, setIsLayoutPopoverOpen] = createSignal(false);
    let layoutButtonRef: HTMLDivElement | undefined;
    let layoutPopoverRef: HTMLDivElement | undefined;

    createEffect(() => {
        if (!isLayoutPopoverOpen()) return;

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;

            if (layoutButtonRef?.contains(target) || layoutPopoverRef?.contains(target)) {
                return;
            }

            setIsLayoutPopoverOpen(false);
        };

        document.addEventListener("mousedown", handlePointerDown);
        onCleanup(() => document.removeEventListener("mousedown", handlePointerDown));
    });

    const isChampionIcon = () => {
        if (!props.icon) return false;
        const num = parseInt(props.icon);
        return !isNaN(num) && num >= 0 && num < champions.length;
    };

    return (
        <div class="absolute left-4 top-4 z-40 flex flex-col gap-2">
            <SidebarGroup>
                <div class="group relative">
                    <div
                        class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md"
                        classList={{
                            "border border-slate-600 bg-slate-800": isChampionIcon()
                        }}
                    >
                        <Show
                            when={props.icon}
                            fallback={
                                <LayoutDashboard size={32} class="text-purple-400" />
                            }
                        >
                            <IconDisplay
                                icon={props.icon}
                                size="sm"
                                class="!h-9 !w-9 [&_img]:!h-9 [&_img]:!w-9 [&_span]:!text-2xl"
                            />
                        </Show>
                    </div>
                    <Show when={props.name}>
                        <div class="pointer-events-none absolute left-full top-0 z-[60] ml-2 w-max max-w-xs rounded bg-slate-900 px-3 py-2 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                            <div class="text-sm font-medium text-slate-100">
                                {props.name}
                            </div>
                            <Show when={props.description}>
                                <div class="mt-1 text-xs text-slate-400">
                                    {props.description}
                                </div>
                            </Show>
                        </div>
                    </Show>
                </div>
            </SidebarGroup>

            <SidebarGroup>
                <SidebarButton icon={Plus} tooltip="Zoom in" onClick={props.onZoomIn} />
                <SidebarButton
                    icon={Minus}
                    tooltip="Zoom out"
                    onClick={props.onZoomOut}
                />
                <div class="relative" ref={layoutButtonRef}>
                    <SidebarButton
                        icon={Rows3}
                        tooltip="Card layout"
                        onClick={() =>
                            setIsLayoutPopoverOpen((currentOpen) => !currentOpen)
                        }
                        isActive={isLayoutPopoverOpen()}
                        disabled={!props.hasEditPermissions}
                    />
                    <Show when={isLayoutPopoverOpen()}>
                        <div
                            ref={layoutPopoverRef}
                            class="absolute left-full top-[400%] z-50 ml-3 mt-1 w-64 -translate-y-1/2 rounded-xl border border-slate-600 bg-slate-900 p-2 shadow-xl"
                        >
                            <button
                                type="button"
                                onClick={() => setIsLayoutPopoverOpen(false)}
                                class="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center text-slate-400 transition-colors hover:text-slate-200"
                            >
                                <X size={12} />
                            </button>
                            <div class="mb-2 pl-2 pr-8 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                Card Layout
                            </div>
                            <div class="space-y-1">
                                <For each={layoutOptions}>
                                    {(option) => (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                props.onSelectCardLayout(option.value);
                                                setIsLayoutPopoverOpen(false);
                                            }}
                                            class="flex w-full items-center gap-2.5 rounded-md border px-2 py-2 text-left transition-colors"
                                            classList={{
                                                "border-purple-500 bg-purple-600/15":
                                                    props.cardLayout === option.value,
                                                "border-slate-700 bg-slate-800 hover:border-slate-500 hover:bg-slate-700":
                                                    props.cardLayout !== option.value
                                            }}
                                        >
                                            <div class="flex-none">
                                                {layoutIconMap[option.value]({
                                                    size: 52
                                                })}
                                            </div>
                                            <div class="min-w-0">
                                                <div class="text-sm font-medium text-slate-100">
                                                    {option.label}
                                                </div>
                                                <div class="mt-0.5 text-xs text-slate-400">
                                                    {option.description}
                                                </div>
                                            </div>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </div>
                    </Show>
                </div>
            </SidebarGroup>

            <Show when={props.hasEditPermissions || props.hasAdminPermissions}>
                <SidebarGroup>
                    <Show when={props.hasEditPermissions}>
                        <SidebarButton
                            icon={GitBranch}
                            tooltip={
                                props.isConnectionMode
                                    ? "Exit connection mode"
                                    : "Connection mode"
                            }
                            onClick={props.onToggleConnectionMode}
                            isActive={props.isConnectionMode}
                        />
                    </Show>
                    <Show when={props.hasAdminPermissions && props.onSettings}>
                        <SidebarButton
                            icon={Settings}
                            tooltip="Canvas settings"
                            onClick={() => props.onSettings?.()}
                        />
                    </Show>
                </SidebarGroup>

                <SidebarGroup>
                    <Show when={props.hasEditPermissions}>
                        <SidebarButton
                            icon={Import}
                            tooltip="Import"
                            onClick={props.onImport}
                        />
                    </Show>
                    <Show when={props.hasAdminPermissions && props.onShare}>
                        <div class="relative" ref={(el) => props.setShareButtonRef?.(el)}>
                            <SidebarButton
                                icon={Share2}
                                tooltip="Share canvas"
                                onClick={() => props.onShare?.()}
                                isActive={!!props.sharePopperContent}
                            />
                            {props.sharePopperContent}
                        </div>
                    </Show>
                </SidebarGroup>
            </Show>
        </div>
    );
};

export default CanvasSidebar;
