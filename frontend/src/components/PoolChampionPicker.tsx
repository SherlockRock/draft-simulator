import { Component, createMemo } from "solid-js";
import type { CanvasPoolPlacement, Role, Viewport } from "../utils/schemas";
import { ROLE_LABELS } from "../utils/championRoles";
import { poolChampionIsAvailable } from "../utils/poolCard";
import { CanvasPickerPopover } from "./CanvasPickerPopover";
import { ChampionPickerCore } from "./ChampionPickerCore";

// Target carries IDS only; the placement row is derived live from the store
// on every read — the annotation-picker precedent (Canvas.tsx ~7515 derives by
// annotations.find). A captured row object would go stale on canvas switch or
// delete-and-recreate.
type PoolChampionPickerProps = {
    target: () => { placementId: string; role: Role } | null;
    resolvePlacement: (placementId: string) => CanvasPoolPlacement | null;
    anchorSession: () => number;
    viewport: () => Viewport;
    onPick: (championId: string) => void;
    onClose: () => void;
};

export const PoolChampionPicker: Component<PoolChampionPickerProps> = (props) => {
    const livePlacement = createMemo(() => {
        const target = props.target();
        return target ? props.resolvePlacement(target.placementId) : null;
    });
    const anchorKey = createMemo(() => {
        const target = props.target();
        return target && livePlacement() ? `${target.placementId}:${target.role}` : null;
    });

    return (
        <CanvasPickerPopover
            anchorKey={anchorKey}
            anchorSession={props.anchorSession}
            trackAnchorPosition={(key) => {
                const target = props.target();
                const placement = livePlacement();
                if (
                    !target ||
                    !placement ||
                    `${target.placementId}:${target.role}` !== key
                )
                    return false;
                void placement.positionX;
                void placement.positionY;
                return true;
            }}
            resolveAnchorElement={(key) => {
                const placementId = key.split(":")[0];
                const el = document.querySelector(
                    `.canvas-pool-card[data-pool-id="${placementId}"]`
                );
                return el instanceof HTMLElement ? el : null;
            }}
            viewport={props.viewport}
            onClose={props.onClose}
        >
            <ChampionPickerCore
                onPick={(championId) => props.onPick(championId)}
                onClose={props.onClose}
                // Per-bucket availability (D3): already-in-THIS-role greys out;
                // in-another-role stays available — that's how flexing happens.
                // Delegates to poolChampionIsAvailable so the rule is
                // unit-tested directly, not just mirrored in a test double.
                isAvailable={(championId) => {
                    const target = props.target();
                    const placement = livePlacement();
                    if (!target || !placement) return false;
                    return poolChampionIsAvailable(
                        placement.Pool.champions,
                        target.role,
                        championId
                    );
                }}
                contextLabel={`Add to ${ROLE_LABELS[props.target()?.role ?? "top"]}`}
                targetKey={anchorKey() ?? ""}
            />
        </CanvasPickerPopover>
    );
};
