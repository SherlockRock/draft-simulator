import { championByName, champions, type Champion } from "./constants";

/**
 * Inline champion tokens (inline-champions design §1–§2).
 *
 * A champion is the literal substring `@[<display name>]`. Whatever the
 * brackets enclose is the token's raw text; resolution decides whether it is
 * a champion. D16 (relocated here): a name that resolves to nothing is KEPT
 * and rendered marked — dropping it is silent data loss, a gap reads as a
 * layout bug. No escape grammar; `@[` has no organic use in draft notes.
 */
export type AnnotationSegment =
    | { kind: "text"; value: string }
    | { kind: "champion"; raw: string; resolved: Champion | null };

// One-or-more chars that are not `]` or a newline; `@[]` stays literal text.
const TOKEN_PATTERN = /@\[([^\]\n]+)\]/g;

export const parseAnnotationText = (text: string): AnnotationSegment[] => {
    const segments: AnnotationSegment[] = [];
    const pattern = new RegExp(TOKEN_PATTERN.source, "g");
    let last = 0;
    let match = pattern.exec(text);
    while (match !== null) {
        if (match.index > last) {
            segments.push({ kind: "text", value: text.slice(last, match.index) });
        }
        const raw = match[1];
        segments.push({
            kind: "champion",
            raw,
            resolved: championByName.get(raw) ?? null
        });
        last = match.index + match[0].length;
        match = pattern.exec(text);
    }
    if (last < text.length) {
        segments.push({ kind: "text", value: text.slice(last) });
    }
    return segments;
};

/**
 * The zoom-collapse cluster's data (design §4): unique, first-appearance
 * order, unresolved excluded. Dedup at RENDER is a display concern — the
 * content model allows duplicates (D18 repealed).
 */
export const uniqueChampions = (segments: readonly AnnotationSegment[]): Champion[] => {
    const seen = new Set<string>();
    const result: Champion[] = [];
    for (const segment of segments) {
        if (segment.kind !== "champion" || segment.resolved === null) continue;
        if (seen.has(segment.resolved.id)) continue;
        seen.add(segment.resolved.id);
        result.push(segment.resolved);
    }
    return result;
};

/**
 * Splice `@[Name] ` over [replaceStart, replaceEnd). Serves both editor
 * affordances (§3): right-click insert replaces the selection; autocomplete
 * accept replaces `@<partial>` (mention start → caret). Bounds are clamped
 * and ordered — the captured selection can be stale by the time the picker
 * resolves, and a bad splice must degrade, never throw.
 */
export const insertChampionToken = (
    text: string,
    replaceStart: number,
    replaceEnd: number,
    name: string
): { text: string; caret: number } => {
    const clamp = (n: number) => Math.min(Math.max(n, 0), text.length);
    const start = Math.min(clamp(replaceStart), clamp(replaceEnd));
    const end = Math.max(clamp(replaceStart), clamp(replaceEnd));
    const token = `@[${name}] `;
    return {
        text: text.slice(0, start) + token + text.slice(end),
        caret: start + token.length
    };
};

/**
 * The mention context at the caret (§3): the run of characters after the
 * nearest `@` left of the caret. The run is bounded to name-shaped
 * characters (letters, digits, apostrophe, period, ampersand, space, dash
 * — the alphabet of the roster's display names) and 24 chars: a bracket
 * means the user is inside or just past real token syntax; a newline or
 * punctuation means prose; and an unbounded run would keep the popover —
 * and its Enter suppression — armed across an arbitrary tail of typing.
 */
const MENTION_RUN = /^[A-Za-z0-9'.& -]{0,24}$/;

export const mentionQueryAt = (
    text: string,
    caret: number
): { start: number; query: string } | null => {
    const upToCaret = text.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at === -1) return null;
    const run = upToCaret.slice(at + 1);
    if (!MENTION_RUN.test(run)) return null;
    // A leading space means prose ("50/50 @ Ahri"), not a mention — every
    // real completion starts typing the name directly after the @. Interior
    // spaces stay legal for multi-word names (`@Aurelion S`).
    if (run.startsWith(" ")) return null;
    return { start: at, query: run };
};

/**
 * Mention matching: the trimmed query must PREFIX a name or one of its
 * words, case-insensitively, roster order preserved.
 *
 * Deliberate deviation from ChampionPickerCore's substring matching, and
 * §3's "reuses the search logic" is read as intent, not letter: because a
 * mention run legitimately contains spaces (`@Aurelion S`), substring
 * matching makes prose after a stray `@` (" Zed maybe") light the popover
 * mid-sentence — at which point Enter REPLACES the prose span instead of
 * inserting a newline. Prefix-per-word keeps every real completion path
 * (`@kai`, `@sol`) and closes that trap.
 */
export const championsMatchingQuery = (query: string): Champion[] => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [...champions];
    return champions.filter((c) => {
        const name = c.name.toLowerCase();
        if (name.startsWith(needle)) return true;
        return name.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle));
    });
};
