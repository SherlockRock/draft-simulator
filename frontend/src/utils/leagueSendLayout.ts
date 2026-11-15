import type { CardLayout } from "./canvasCardLayout";
import { getSeriesGroupDimensions } from "./helpers";

/** Vertical gap between two league series sent as a column (plan D5). */
export const LEAGUE_SEND_ROW_GAP = 48;

/**
 * Distance between the tops of two series groups in a bulk-send column: the
 * series frame height for the canvas's card layout plus the gap, rounded up
 * to a whole pixel. The frame height doesn't depend on the card count.
 */
export function rowStepFor(cardLayout: CardLayout): number {
    return Math.ceil(
        getSeriesGroupDimensions(1, cardLayout).height + LEAGUE_SEND_ROW_GAP
    );
}
