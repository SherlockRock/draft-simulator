import { championByName, type Champion } from "./constants";

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
