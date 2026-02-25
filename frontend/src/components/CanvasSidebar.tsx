import { Component, Show } from "solid-js";
import {
    Plus,
    Minus,
    Maximize2,
    ArrowLeftRight,
    Import,
    GitBranch
} from "lucide-solid";

interface CanvasSidebarProps {
    // Zoom controls
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFitToScreen: () => void;
    // Canvas controls
    onSwapOrientation: () => void;
    onImport: () => void;
    // Mode controls
    isConnectionMode: boolean;
    onToggleConnectionMode: () => void;
    // Permissions
    hasEditPermissions: boolean;
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

const Separator: Component = () => (
    <div class="my-1 border-t border-slate-600" />
);

const CanvasSidebar: Component<CanvasSidebarProps> = (props) => {
    return (
        <div class="absolute left-4 top-16 z-40 flex flex-col gap-1 rounded-lg border border-slate-600 bg-slate-800 p-1.5">
            {/* Zoom controls */}
            <SidebarButton
                icon={Plus}
                tooltip="Zoom in"
                onClick={props.onZoomIn}
            />
            <SidebarButton
                icon={Minus}
                tooltip="Zoom out"
                onClick={props.onZoomOut}
            />
            <SidebarButton
                icon={Maximize2}
                tooltip="Fit to screen"
                onClick={props.onFitToScreen}
            />

            <Separator />

            {/* Canvas controls */}
            <SidebarButton
                icon={ArrowLeftRight}
                tooltip="Swap orientation"
                onClick={props.onSwapOrientation}
            />
            <Show when={props.hasEditPermissions}>
                <SidebarButton
                    icon={Import}
                    tooltip="Import"
                    onClick={props.onImport}
                />
            </Show>

            <Separator />

            {/* Mode controls */}
            <Show when={props.hasEditPermissions}>
                <SidebarButton
                    icon={GitBranch}
                    tooltip={props.isConnectionMode ? "Exit connection mode" : "Connection mode"}
                    onClick={props.onToggleConnectionMode}
                    isActive={props.isConnectionMode}
                />
            </Show>
        </div>
    );
};

export default CanvasSidebar;
