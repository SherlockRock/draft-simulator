import {
    countsInScope,
    effectiveGameType,
    resolvesTeamNames,
    type SearchScope
} from "./gameClassification";
import type { CanvasGroup } from "./schemas";
import { isPlaceholderTeamName } from "./teamLink";

/**
 * What search treats as "a team": `"id:<uuid>"` for a linked slot,
 * `"name:<lowercased trimmed>"` for an unlinked free-text name. A plain string
 * so signals, Sets and option lists stay as they were when search keyed by name.
 */
export type SearchTeamKey = string;

export type GroupTeamKeys = { team1: SearchTeamKey | null; team2: SearchTeamKey | null };

export type TeamKeyIndex = {
    /** Every group passed in; groups that resolve no team names map to nulls. */
    keysByGroup: Map<string, GroupTeamKeys>;
    /** Unique across the index, and independent of the scope chip. */
    labelByKey: Map<SearchTeamKey, string>;
};

export type TeamOption = { key: SearchTeamKey; label: string };

type LinkedInfo = {
    /** Display name: the entity's name, else the group's free text. */
    name: string;
    /** The entity's own name (lowercased); only entity names take part in folding. */
    entityNameLower: string | null;
    tournament: string | null;
};

type SlotRef = { kind: "id"; id: string } | { kind: "name"; lower: string; name: string };

const freeText = (name: string | undefined): string | null => {
    const trimmed = name?.trim();
    return trimmed && !isPlaceholderTeamName(trimmed) ? trimmed : null;
};

const idKey = (id: string): SearchTeamKey => `id:${id}`;
const nameKeyOf = (lower: string): SearchTeamKey => `name:${lower}`;

/**
 * Builds the key index for a WHOLE canvas (never per scope, so a key and its
 * label never change when the scope chip does).
 *
 * Only the groups passed in take part: the canvas payload holds only the
 * groups and linked teams every member of that canvas already reads, and no
 * team from outside it (the user's own list, another canvas, a league) can
 * change a key or a label. That is why the signature is `groups` alone.
 *
 * Only groups `resolvesTeamNames` admits produce keys (classification design
 * D6/D8). A linked slot keys by team id; an unlinked one by its free-text
 * name, with "Team 1"/"Team 2" placeholders and blanks giving null. An unlinked
 * name folds into the id key of a linked team when exactly ONE distinct team id
 * linked on this canvas has that (trimmed, lowercased) entity name; with none
 * or several it keeps its own `name:` key.
 */
export const buildTeamKeyIndex = (groups: readonly CanvasGroup[]): TeamKeyIndex => {
    const linked = new Map<string, LinkedInfo>();
    const slotRefs = new Map<string, { team1: SlotRef | null; team2: SlotRef | null }>();

    const refFor = (
        group: CanvasGroup,
        team: CanvasGroup["Team1"],
        teamId: string | null | undefined,
        metadataName: string | undefined
    ): SlotRef | null => {
        const id = team?.id ?? teamId;
        const entityName = team?.name?.trim() || null;
        const free = freeText(metadataName);
        if (id) {
            const name = entityName ?? free;
            // A linked slot with no name anywhere has nothing to show, as before.
            if (name === null) return null;
            const known = linked.get(id);
            if (known === undefined) {
                linked.set(id, {
                    name,
                    entityNameLower: entityName?.toLowerCase() ?? null,
                    tournament: team?.Tournament?.name?.trim() || null
                });
            } else {
                if (known.entityNameLower === null && entityName !== null) {
                    known.entityNameLower = entityName.toLowerCase();
                    known.name = entityName;
                }
                if (known.tournament === null && team?.Tournament?.name?.trim()) {
                    known.tournament = team.Tournament.name.trim();
                }
            }
            return { kind: "id", id };
        }
        if (free === null) return null;
        return { kind: "name", lower: free.toLowerCase(), name: free };
    };

    for (const group of groups) {
        if (!resolvesTeamNames(group)) {
            slotRefs.set(group.id, { team1: null, team2: null });
            continue;
        }
        slotRefs.set(group.id, {
            team1: refFor(
                group,
                group.Team1,
                group.team1_id,
                group.metadata.blueTeamName
            ),
            team2: refFor(group, group.Team2, group.team2_id, group.metadata.redTeamName)
        });
    }

    const idsByEntityName = new Map<string, Set<string>>();
    for (const [id, info] of linked) {
        if (info.entityNameLower === null) continue;
        const ids = idsByEntityName.get(info.entityNameLower) ?? new Set<string>();
        ids.add(id);
        idsByEntityName.set(info.entityNameLower, ids);
    }

    const keysByGroup = new Map<string, GroupTeamKeys>();
    /** First-seen order, so label ties and the first-seen casing are deterministic. */
    const entries = new Map<
        SearchTeamKey,
        { name: string; id: string | null; tournament: string | null }
    >();

    const keyFor = (ref: SlotRef | null): SearchTeamKey | null => {
        if (ref === null) return null;
        if (ref.kind === "id") {
            const key = idKey(ref.id);
            const info = linked.get(ref.id);
            if (!entries.has(key) && info !== undefined) {
                entries.set(key, {
                    name: info.name,
                    id: ref.id,
                    tournament: info.tournament
                });
            }
            return key;
        }
        const folded = idsByEntityName.get(ref.lower);
        if (folded !== undefined && folded.size === 1) {
            const [onlyId] = [...folded];
            if (onlyId !== undefined) return keyFor({ kind: "id", id: onlyId });
        }
        const key = nameKeyOf(ref.lower);
        if (!entries.has(key)) {
            entries.set(key, { name: ref.name, id: null, tournament: null });
        }
        return key;
    };

    for (const group of groups) {
        const refs = slotRefs.get(group.id);
        keysByGroup.set(group.id, {
            team1: keyFor(refs?.team1 ?? null),
            team2: keyFor(refs?.team2 ?? null)
        });
    }

    return { keysByGroup, labelByKey: assignLabels(entries) };
};

/** D3: collision-aware, unique labels. */
const assignLabels = (
    entries: ReadonlyMap<
        SearchTeamKey,
        { name: string; id: string | null; tournament: string | null }
    >
): Map<SearchTeamKey, string> => {
    const byName = new Map<string, SearchTeamKey[]>();
    for (const [key, entry] of entries) {
        const lower = entry.name.toLowerCase();
        byName.set(lower, [...(byName.get(lower) ?? []), key]);
    }

    const labels = new Map<SearchTeamKey, string>();
    for (const [key, entry] of entries) labels.set(key, entry.name);

    for (const keys of byName.values()) {
        if (keys.length < 2) continue;
        const linkedKeys = keys
            .filter((key) => entries.get(key)?.id !== null)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const seen = new Map<string, number>();
        for (const key of linkedKeys) {
            const entry = entries.get(key);
            if (entry === undefined) continue;
            const base =
                entry.tournament !== null
                    ? `${entry.name} · ${entry.tournament}`
                    : entry.name;
            const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
            seen.set(base.toLowerCase(), count);
            labels.set(key, count === 1 ? base : `${base} · ${count}`);
        }
        for (const key of keys) {
            const entry = entries.get(key);
            if (entry !== undefined && entry.id === null) {
                labels.set(key, `${entry.name} (unlinked)`);
            }
        }
    }

    // Last guard: two labels may still meet by accident (a team literally named
    // "DOG (unlinked)"). SearchableSelect hands back the label, so it must be unique.
    const used = new Set<string>();
    for (const [key, label] of labels) {
        let candidate = label;
        let n = 2;
        while (used.has(candidate.toLowerCase())) {
            candidate = `${label} · ${n}`;
            n += 1;
        }
        used.add(candidate.toLowerCase());
        labels.set(key, candidate);
    }
    return labels;
};

/**
 * The team picker's list: keys appearing in a group the scope counts, sorted
 * by label. Scope-aware so selecting "scratch" does not offer every scrim-only
 * team and hand back an empty record with no explanation.
 */
export const getTeamOptions = (
    index: TeamKeyIndex,
    groups: readonly CanvasGroup[],
    scope: SearchScope = "all"
): TeamOption[] => {
    const keys = new Set<SearchTeamKey>();
    for (const group of groups) {
        if (!countsInScope(effectiveGameType(undefined, group), scope)) continue;
        const groupKeys = index.keysByGroup.get(group.id);
        if (groupKeys === undefined) continue;
        if (groupKeys.team1 !== null) keys.add(groupKeys.team1);
        if (groupKeys.team2 !== null) keys.add(groupKeys.team2);
    }
    const options: TeamOption[] = [];
    for (const key of keys) {
        const label = index.labelByKey.get(key);
        if (label !== undefined) options.push({ key, label });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
};

/** The opponent dropdown: the same scope-aware list minus the selected team (R1). */
export const getOpponentOptions = (
    index: TeamKeyIndex,
    groups: readonly CanvasGroup[],
    scope: SearchScope,
    teamKey: SearchTeamKey
): TeamOption[] =>
    getTeamOptions(index, groups, scope).filter((option) => option.key !== teamKey);

/** SearchableSelect hands back the label; this maps it to the team's key. */
export const optionKeyForLabel = (
    options: readonly TeamOption[],
    label: string
): SearchTeamKey | null => options.find((option) => option.label === label)?.key ?? null;

/** D7: choosing a team clears the opponent when there is no team or it is the same key. */
export const nextOpponentKey = (
    teamKey: SearchTeamKey | null,
    opponentKey: SearchTeamKey | null
): SearchTeamKey | null => {
    if (teamKey === null || opponentKey === null) return null;
    return teamKey === opponentKey ? null : opponentKey;
};
