import type {
    NavigatorDraftData,
    NavigatorSessionData
} from "../contexts/NavigatorContext";

export function getOurSideForGame(
    session: Pick<NavigatorSessionData, "our_side" | "side_swap_mode">,
    draft: Pick<NavigatorDraftData, "game_number" | "our_side_override">
): "blue" | "red" {
    if (draft.our_side_override) return draft.our_side_override;

    if (session.side_swap_mode === "manual") {
        return session.our_side;
    }

    const gameIndex = draft.game_number - 1;
    const baseSide = session.our_side;
    if (gameIndex % 2 === 0) return baseSide;
    return baseSide === "blue" ? "red" : "blue";
}

// Compute the side for a future game number within the series, before the
// corresponding NavigatorDraft row exists (used for the between-games panel
// and tab strip "not-started" projections).
export function getProjectedSideForGameNumber(
    session: Pick<NavigatorSessionData, "our_side" | "side_swap_mode">,
    gameNumber: number
): "blue" | "red" {
    return getOurSideForGame(session, {
        game_number: gameNumber,
        our_side_override: null
    });
}
