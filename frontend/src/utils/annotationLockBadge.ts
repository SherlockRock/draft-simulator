/**
 * Sizing rules for the advisory edit-lock indicator (design D12).
 *
 * The badge is the WHOLE user-facing half of the lock: the textarea's
 * `readOnly` is invisible, and a double-click that declines to open the editor
 * looks identical to a double-click that missed. So unlike the note's own text
 * — which is content, and collapses to a colour block when it stops being
 * legible (§4) — this must survive zooming out.
 */

/** On-screen text size for the badge label, in post-transform css px. */
export const LOCK_BADGE_TEXT_SCREEN_PX = 10;

/**
 * On-screen width a note needs before the badge spells out who holds it.
 *
 * "Someone else is editing" is the longest label the fallback can produce; this
 * is sized for the common `<name> is editing` at the text size above, with the
 * pill's own padding. Below it the badge would be wider than the note it
 * annotates — and since the note's root gave up `overflow-hidden` so the
 * connection anchors could straddle its border, an over-wide badge no longer
 * clips, it SPILLS onto whatever is beside the note.
 */
export const LOCK_BADGE_LABEL_MIN_SCREEN_PX = 96;

/** On-screen diameter of the collapsed dot, in post-transform css px. */
export const LOCK_BADGE_DOT_SCREEN_PX = 8;

export type LockBadgeMode = "label" | "dot";

/**
 * Whether the badge can spell out the holder's name at this zoom, or has to
 * collapse to a dot.
 *
 * Screen-constant sizing is the point — a world-space badge is ~1px at
 * `MIN_ZOOM` — but screen-constant ALONE inverts the problem, exactly as
 * `resizeHandleWorldPx` documents for the resize grip: hold the words at 10
 * screen px and they grow, in world terms, until they are wider than the note
 * they belong to. Hence the dot: the signal survives, the words do not.
 *
 * ⚠️ Deliberately has NO hysteresis band, unlike `nextLodState` and
 * `nextLegibleState` next door, and the difference is what flips. Those swap
 * forty cards' interiors, or every note's text, on alternate frames while the
 * pointer hovers a threshold. This swaps one corner element on a note someone
 * else is editing right now — it reflows nothing and repaints nothing else, so
 * the band would cost a threaded `previous` for no visible gain. If a third
 * caller ever wants one, reach for `nextLegibleState`'s shape rather than
 * inventing a second.
 *
 * An unusable zoom or width holds the LABEL: the arithmetic alone would return
 * `false` for NaN and quietly downgrade the only signal the lock has, and a
 * transient NaN must not do that.
 */
export const lockBadgeMode = (
    zoom: number,
    renderWidthWorldPx: number
): LockBadgeMode => {
    if (!Number.isFinite(zoom) || zoom <= 0) return "label";
    if (!Number.isFinite(renderWidthWorldPx) || renderWidthWorldPx <= 0) {
        return "label";
    }
    return renderWidthWorldPx * zoom >= LOCK_BADGE_LABEL_MIN_SCREEN_PX ? "label" : "dot";
};
