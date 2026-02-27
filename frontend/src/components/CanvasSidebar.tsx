import { Component, JSX, Show } from "solid-js";
import {
    Plus,
    Minus,
    ArrowLeftRight,
    Import,
    GitBranch,
    Settings,
    Share2
} from "lucide-solid";
import { IconDisplay } from "./IconDisplay";

interface CanvasSidebarProps {
    // Canvas info
    icon?: string | null;
    name?: string;
    description?: string | null;
    // Zoom controls
    onZoomIn: () => void;
    onZoomOut: () => void;
    // Canvas controls
    onSwapOrientation: () => void;
    onImport: () => void;
    // Mode controls
    isConnectionMode: boolean;
    onToggleConnectionMode: () => void;
    // Permissions
    hasEditPermissions: boolean;
    hasAdminPermissions: boolean;
    // Settings
    onSettings?: () => void;
    // Share
    onShare?: () => void;
    onShareFocusOut?: (e: FocusEvent) => void;
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
                    "bg-purple-600 hover:bg-purple-500 border-purple-500": props.isActive,
                    "bg-slate-800 hover:bg-slate-700": !props.isActive,
                    "opacity-50 cursor-not-allowed": props.disabled
                }}
            >
                <props.icon size={18} class="text-slate-200" />
            </button>
            <div class="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
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
    return (
        <div class="absolute left-4 top-4 z-40 flex flex-col gap-2">
            {/* Canvas icon */}
            <Show when={props.icon}>
                <SidebarGroup>
                    <div class="group relative">
                        <div class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md border border-slate-600 bg-slate-800">
                            <IconDisplay
                                icon={props.icon}
                                size="sm"
                                className="!h-9 !w-9 [&_img]:!h-9 [&_img]:!w-9 [&_span]:!text-2xl"
                            />
                        </div>
                        <Show when={props.name}>
                            <div class="pointer-events-none absolute left-full top-0 z-50 ml-2 w-max max-w-xs rounded bg-slate-900 px-3 py-2 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
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
            </Show>

            {/* Zoom controls + swap orientation */}
            <SidebarGroup>
                <SidebarButton icon={Plus} tooltip="Zoom in" onClick={props.onZoomIn} />
                <SidebarButton
                    icon={Minus}
                    tooltip="Zoom out"
                    onClick={props.onZoomOut}
                />
                <SidebarButton
                    icon={ArrowLeftRight}
                    tooltip="Swap orientation"
                    onClick={props.onSwapOrientation}
                />
            </SidebarGroup>

            {/* Mode + settings */}
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
                            onClick={props.onSettings!}
                        />
                    </Show>
                </SidebarGroup>

                {/* Import + share */}
                <SidebarGroup>
                    <Show when={props.hasEditPermissions}>
                        <SidebarButton
                            icon={Import}
                            tooltip="Import"
                            onClick={props.onImport}
                        />
                    </Show>
                    <Show when={props.hasAdminPermissions && props.onShare}>
                        <div class="relative" onFocusOut={props.onShareFocusOut}>
                            <SidebarButton
                                icon={Share2}
                                tooltip="Share canvas"
                                onClick={props.onShare!}
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
