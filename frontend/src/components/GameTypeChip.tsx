import { Show, type Component } from "solid-js";
import type { GameType } from "@draft-sim/shared-types";

/**
 * Header chip for a group's game classification (design D9). It replaces the
 * old Scrim/Competitive badge, which reported the versus ruleset-lockdown flag;
 * under D2 that lockdown is a consequence of Official, not a separate fact
 * worth its own chip.
 *
 * Untagged renders NOTHING. That is a real, ongoing state — migrations do not
 * re-run and local canvases sync in untagged — not a legacy remnant. It filters
 * as Scrim on series groups via the structural fallback. A chip reading
 * "Untagged" on every such group would be worse noise, but it is the reason the
 * "N groups need classifying" affordance is worth building later (D1).
 */
const CHIP: Record<GameType, { label: string; class: string }> = {
    // Ember carries the visual meaning over from the old "Competitive" chip, so
    // live series look unchanged after the backfill.
    official: { label: "Official", class: "bg-darius-ember/20 text-darius-ember" },
    scrim: {
        label: "Scrim",
        class: "bg-darius-card-hover text-darius-text-secondary"
    },
    scratch: {
        label: "Scratch",
        class: "bg-darius-disabled/40 text-darius-text-secondary"
    }
};

export const GameTypeChip: Component<{ gameType: GameType | undefined }> = (props) => (
    <Show when={props.gameType && CHIP[props.gameType]}>
        {(chip) => (
            <span class={`rounded px-2 py-0.5 text-xs ${chip().class}`}>
                {chip().label}
            </span>
        )}
    </Show>
);
