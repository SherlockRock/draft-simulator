import { champions } from "./constants";

// Normalize a champion name for matching:
// - lowercase
// - strip apostrophes, periods, spaces, hyphens
// - strip accents (NFD decomposition + remove combining marks)
//
// This tolerates common variants: "K'Sante" ↔ "Ksante", "Kha'Zix" ↔ "Khazix",
// "Dr. Mundo" ↔ "DrMundo", "Nunu & Willump" ↔ "NunuWillump".
function normalizeName(raw: string): string {
    return raw
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

const normalizedIdIndex: Map<string, string> = (() => {
    const index = new Map<string, string>();
    for (const c of champions) {
        index.set(normalizeName(c.id), c.id);
        index.set(normalizeName(c.name), c.id);
    }
    return index;
})();

export interface ResolveNameResult {
    resolved: string[]; // champion IDs
    unresolved: string[]; // raw input names that did not match
}

// Resolve an array of champion names (case- and punctuation-insensitive) into
// champion IDs. Duplicates are preserved in resolved order (caller decides
// whether to de-dupe). Unmatched inputs are collected for a warning UI.
export function resolveChampionNames(names: string[]): ResolveNameResult {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const raw of names) {
        if (typeof raw !== "string" || raw.trim().length === 0) {
            unresolved.push(raw);
            continue;
        }
        const key = normalizeName(raw);
        const id = normalizedIdIndex.get(key);
        if (id) {
            resolved.push(id);
        } else {
            unresolved.push(raw);
        }
    }
    return { resolved, unresolved };
}
