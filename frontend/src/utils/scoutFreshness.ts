const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a scout envelope was fetched, in the terse form a 232px column
 * has room for ("12m ago"). Returns "" for an unparseable timestamp so the
 * caller can hide the label rather than print "NaN".
 *
 * The instant comes from `envelope.fetchedAt`, so a response served from the
 * backend's TTL cache reports when u.gg was actually asked — not when this
 * browser received it. That is the whole point of the label.
 */
export function formatFetchedAgo(fetchedAt: string, now: number): string {
    const then = Date.parse(fetchedAt);
    if (Number.isNaN(then)) return "";
    // Clock skew between the fetching server and this browser is routine; a
    // negative age is not worth rendering as such.
    const elapsed = Math.max(0, now - then);
    if (elapsed < MINUTE) return "just now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
    return `${Math.floor(elapsed / DAY)}d ago`;
}
