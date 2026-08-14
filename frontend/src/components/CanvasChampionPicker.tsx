import { Component, Show, createMemo } from "solid-js";
import { CanvasDraft, Viewport } from "../utils/schemas";
import {
    CardLayout,
    getDirectionalCanvasSlotIndex,
    getEnterAdvanceSlotIndex,
    getIndexToShorthandForLayout
} from "../utils/canvasCardLayout";
import { CanvasPickerPopover } from "./CanvasPickerPopover";
import { ChampionPickerCore } from "./ChampionPickerCore";

export interface PickerTarget {
    draftId: string;
    pickIndex: number;
}

type CanvasChampionPickerProps = {
    target: () => PickerTarget | null;
    /** Bumped by Canvas on every slot click — re-anchors fresh beside that card. */
    anchorSession: () => number;
    onRetarget: (target: PickerTarget) => void;
    onClose: () => void;
    handlePickChange: (draftId: string, pickIndex: number, championId: string) => void;
    getDraft: (draftId: string) => CanvasDraft | undefined;
    getUnavailableChampionIds: (draftId: string) => Set<string>;
    cardLayout: () => CardLayout;
    viewport: () => Viewport;
};

export const CanvasChampionPicker: Component<CanvasChampionPickerProps> = (props) => {
    // Notifies only when the anchored CARD changes — advance retargets within
    // the same card and must NOT re-derive the anchor (a re-measure re-clamps,
    // which would move a popover the user had panned partly off-pane).
    const targetDraftId = createMemo(() => props.target()?.draftId ?? null);

    const advance = (reverse: boolean) => {
        const target = props.target();
        if (!target) return;
        const next = getEnterAdvanceSlotIndex(
            props.cardLayout(),
            target.pickIndex,
            reverse ? "backward" : "forward"
        );
        if (next === null) {
            props.onClose();
        } else {
            props.onRetarget({ draftId: target.draftId, pickIndex: next });
        }
    };

    const handlePick = (championId: string, reverse: boolean) => {
        const target = props.target();
        if (!target) return;
        props.handlePickChange(target.draftId, target.pickIndex, championId);
        advance(reverse);
    };

    const handleTab = (reverse: boolean) => {
        const target = props.target();
        if (!target) return;
        props.onRetarget({
            draftId: target.draftId,
            pickIndex: getDirectionalCanvasSlotIndex(
                props.cardLayout(),
                target.pickIndex,
                "horizontal",
                reverse ? "backward" : "forward"
            )
        });
    };

    const unavailableIds = createMemo(() => {
        const target = props.target();
        return target
            ? props.getUnavailableChampionIds(target.draftId)
            : new Set<string>();
    });

    const contextLabel = createMemo(() => {
        const target = props.target();
        if (!target) return "";
        const name = props.getDraft(target.draftId)?.Draft.name.trim();
        const slot =
            getIndexToShorthandForLayout(props.cardLayout())[target.pickIndex] ??
            `#${target.pickIndex + 1}`;
        return name ? `${name} — ${slot}` : slot;
    });

    return (
        <CanvasPickerPopover
            anchorKey={targetDraftId}
            anchorSession={props.anchorSession}
            trackAnchorPosition={(id) => {
                const cd = props.getDraft(id);
                if (!cd) return false;
                void cd.positionX;
                void cd.positionY;
                void cd.group_id;
                void cd.Draft.seriesIndex;
                return true;
            }}
            resolveAnchorElement={(id) => {
                const el = document.querySelector(`.canvas-card[data-draft-id="${id}"]`);
                return el instanceof HTMLElement ? el : null;
            }}
            viewport={props.viewport}
            onClose={props.onClose}
        >
            <Show when={props.target()}>
                {(target) => (
                    <ChampionPickerCore
                        onPick={handlePick}
                        onSkip={advance}
                        onTab={handleTab}
                        onClose={props.onClose}
                        isAvailable={(id) => !unavailableIds().has(id)}
                        contextLabel={contextLabel()}
                        targetKey={`${target().draftId}:${target().pickIndex}`}
                    />
                )}
            </Show>
        </CanvasPickerPopover>
    );
};
