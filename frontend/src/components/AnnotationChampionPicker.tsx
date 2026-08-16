import { Component, createMemo } from "solid-js";
import type { CanvasAnnotation, Viewport } from "../utils/schemas";
import { CanvasPickerPopover } from "./CanvasPickerPopover";
import { ChampionPickerCore } from "./ChampionPickerCore";

type AnnotationChampionPickerProps = {
    annotation: () => CanvasAnnotation | null;
    anchorSession: () => number;
    viewport: () => Viewport;
    onPick: (championId: string) => void;
    onClose: () => void;
};

export const AnnotationChampionPicker: Component<AnnotationChampionPickerProps> = (
    props
) => {
    const anchorKey = createMemo(() => props.annotation()?.id ?? null);

    return (
        <CanvasPickerPopover
            anchorKey={anchorKey}
            anchorSession={props.anchorSession}
            trackAnchorPosition={(key) => {
                const annotation = props.annotation();
                if (!annotation || annotation.id !== key) return false;
                void annotation.positionX;
                void annotation.positionY;
                void annotation.group_id;
                return true;
            }}
            resolveAnchorElement={(id) => {
                const el = document.querySelector(
                    `.canvas-annotation[data-annotation-id="${id}"]`
                );
                return el instanceof HTMLElement ? el : null;
            }}
            viewport={props.viewport}
            onClose={props.onClose}
        >
            <ChampionPickerCore
                onPick={(championId) => props.onPick(championId)}
                onClose={props.onClose}
                // D18 is repealed (inline-champions §1): prose legitimately repeats
                // champions, so the picker never greys one out.
                isAvailable={() => true}
                contextLabel="Insert into note"
                targetKey={anchorKey() ?? ""}
            />
        </CanvasPickerPopover>
    );
};
