import { For } from "solid-js";
import type {
    AnnotationColor,
    AnnotationFontSize,
    CanvasAnnotation
} from "../utils/schemas";
import {
    ANNOTATION_COLOR_OPTIONS,
    ANNOTATION_FONT_OPTIONS
} from "../utils/annotationStyle";
import type { ContextMenuEntry } from "../utils/types";
import { ContextMenu } from "./ContextMenu";

type AnnotationContextMenuProps = {
    position: { x: number; y: number };
    annotation: CanvasAnnotation;
    onEditText: () => void;
    onSetColor: (color: AnnotationColor) => void;
    onSetFontSize: (fontSize: AnnotationFontSize) => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onClose: () => void;
};

export const AnnotationContextMenu = (props: AnnotationContextMenuProps) => {
    const entries = (): ContextMenuEntry[] => [
        { label: "Edit text", action: props.onEditText },
        {
            render: (close) => (
                <div class="flex gap-2 border-t border-darius-border px-4 py-2">
                    <For each={ANNOTATION_COLOR_OPTIONS}>
                        {(option) => (
                            <button
                                aria-label={option.label}
                                class={`h-6 w-6 rounded-full border-2 ${option.swatchClass}`}
                                classList={{
                                    "ring-2 ring-darius-purple-bright ring-offset-2 ring-offset-darius-card-hover":
                                        props.annotation.color === option.value
                                }}
                                onClick={() => {
                                    props.onSetColor(option.value);
                                    close();
                                }}
                            />
                        )}
                    </For>
                </div>
            )
        },
        {
            render: (close) => (
                <div class="flex gap-1 border-t border-darius-border px-4 py-2">
                    <For each={ANNOTATION_FONT_OPTIONS}>
                        {(option) => (
                            <button
                                class="rounded px-2 py-1 text-sm text-darius-text-primary hover:bg-darius-border"
                                classList={{
                                    "bg-darius-purple-bright text-slate-50":
                                        props.annotation.fontSize === option.value
                                }}
                                onClick={() => {
                                    props.onSetFontSize(option.value);
                                    close();
                                }}
                            >
                                {option.label}
                            </button>
                        )}
                    </For>
                </div>
            )
        },
        { label: "Duplicate", action: props.onDuplicate },
        { label: "Delete", action: props.onDelete, destructive: true }
    ];

    return (
        <ContextMenu
            class="annotation-context-menu"
            position={props.position}
            actions={entries()}
            onClose={props.onClose}
        />
    );
};
