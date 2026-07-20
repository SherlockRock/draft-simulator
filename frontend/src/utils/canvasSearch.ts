import type { CanvasDraft, CanvasGroup } from "./schemas";

export type SlotPhase = "ban" | "pick";
export type SlotSide = "blue" | "red";
export type SearchBucket = "pickedBy" | "pickedAgainst" | "bannedBy" | "bannedAgainst";

export type SlotKind = { phase: SlotPhase; side: SlotSide };

export type SearchQuery = {
    /** Canonical champion id (e.g. "Jinx"). */
    championId: string;
    /** Case-insensitive team-name filter; null = champion-only search. */
    teamName: string | null;
    /** Restrict match highlights to one bucket; null = all buckets. */
    bucket: SearchBucket | null;
};

export type MatchSlot = {
    index: number;
    phase: SlotPhase;
    side: SlotSide;
    /** Bucket relative to the filtered team; null when no team filter. */
    bucket: SearchBucket | null;
};

export type MatchOutcome = "win" | "loss" | "noResult";

export type DraftMatch = {
    draftId: string;
    groupId: string | null;
    slots: MatchSlot[];
    inProgress: boolean;
    /** From the filtered team's perspective; null without team filter or while in progress. */
    outcome: MatchOutcome | null;
};

export type BucketSummary = {
    games: number;
    wins: number;
    losses: number;
    noResult: number;
    inProgress: number;
};

export type SearchResults = {
    matches: DraftMatch[];
    /** Totals ignore the active bucket filter so the strip stays stable; null without team filter. */
    buckets: Record<SearchBucket, BucketSummary> | null;
};

/** picks[] layout: 0-4 blue bans, 5-9 red bans, 10-14 blue picks, 15-19 red picks. */
export const classifySlot = (index: number): SlotKind => ({
    phase: index < 10 ? "ban" : "pick",
    side: index < 5 || (index >= 10 && index < 15) ? "blue" : "red"
});

/** Versus-imported drafts carry `completed`; manual drafts count as in progress while any pick slot is empty. */
export const isDraftInProgress = (draft: CanvasDraft): boolean => {
    if (draft.Draft.completed !== undefined) return !draft.Draft.completed;
    return draft.Draft.picks.some((value, index) => index >= 10 && value === "");
};

const normalizeName = (name: string | undefined): string | null => {
    const trimmed = name?.trim().toLowerCase();
    return trimmed ? trimmed : null;
};

export const teamSideInDraft = (
    draft: CanvasDraft,
    group: CanvasGroup | undefined,
    teamName: string
): SlotSide | null => {
    if (!group) return null;
    const target = normalizeName(teamName);
    if (!target) return null;
    const team1 = normalizeName(group.metadata.blueTeamName);
    const team2 = normalizeName(group.metadata.redTeamName);
    const blueSideTeam = draft.Draft.blueSideTeam ?? 1;
    if (team1 === target) return blueSideTeam === 1 ? "blue" : "red";
    if (team2 === target) return blueSideTeam === 1 ? "red" : "blue";
    return null;
};

export const bucketFor = (kind: SlotKind, teamSide: SlotSide): SearchBucket => {
    if (kind.phase === "pick") {
        return kind.side === teamSide ? "pickedBy" : "pickedAgainst";
    }
    return kind.side === teamSide ? "bannedBy" : "bannedAgainst";
};

/** Distinct team names across all groups (case-insensitive, first casing wins), sorted. */
export const getTeamNameOptions = (groups: readonly CanvasGroup[]): string[] => {
    const seen = new Map<string, string>();
    for (const group of groups) {
        for (const raw of [group.metadata.blueTeamName, group.metadata.redTeamName]) {
            const trimmed = raw?.trim();
            if (!trimmed) continue;
            const key = trimmed.toLowerCase();
            if (!seen.has(key)) seen.set(key, trimmed);
        }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

const emptyBucketSummary = (): BucketSummary => ({
    games: 0,
    wins: 0,
    losses: 0,
    noResult: 0,
    inProgress: 0
});

const computeOutcome = (
    draft: CanvasDraft,
    teamSide: SlotSide,
    inProgress: boolean
): MatchOutcome | null => {
    if (inProgress) return null;
    const winner = draft.Draft.winner;
    if (!winner) return "noResult";
    return winner === teamSide ? "win" : "loss";
};

export const computeSearchResults = (
    drafts: readonly CanvasDraft[],
    groups: readonly CanvasGroup[],
    query: SearchQuery,
    resolvePick: (pickValue: string) => string
): SearchResults => {
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const buckets =
        query.teamName !== null
            ? {
                  pickedBy: emptyBucketSummary(),
                  pickedAgainst: emptyBucketSummary(),
                  bannedBy: emptyBucketSummary(),
                  bannedAgainst: emptyBucketSummary()
              }
            : null;
    const matches: DraftMatch[] = [];

    for (const canvasDraft of drafts) {
        const group = canvasDraft.group_id
            ? groupById.get(canvasDraft.group_id)
            : undefined;

        let teamSide: SlotSide | null = null;
        if (query.teamName !== null) {
            teamSide = teamSideInDraft(canvasDraft, group, query.teamName);
            if (teamSide === null) continue;
        }

        const allSlots: MatchSlot[] = [];
        canvasDraft.Draft.picks.forEach((value, index) => {
            if (value === "" || resolvePick(value) !== query.championId) return;
            const kind = classifySlot(index);
            allSlots.push({
                index,
                phase: kind.phase,
                side: kind.side,
                bucket: teamSide !== null ? bucketFor(kind, teamSide) : null
            });
        });
        if (allSlots.length === 0) continue;

        const inProgress = isDraftInProgress(canvasDraft);
        const outcome =
            teamSide !== null ? computeOutcome(canvasDraft, teamSide, inProgress) : null;

        if (buckets !== null) {
            const seenBuckets = new Set<SearchBucket>();
            for (const slot of allSlots) {
                if (slot.bucket === null || seenBuckets.has(slot.bucket)) continue;
                seenBuckets.add(slot.bucket);
                const summary = buckets[slot.bucket];
                summary.games += 1;
                if (inProgress) summary.inProgress += 1;
                else if (outcome === "win") summary.wins += 1;
                else if (outcome === "loss") summary.losses += 1;
                else summary.noResult += 1;
            }
        }

        const slots =
            query.bucket !== null
                ? allSlots.filter((slot) => slot.bucket === query.bucket)
                : allSlots;
        if (slots.length === 0) continue;

        matches.push({
            draftId: canvasDraft.Draft.id,
            groupId: canvasDraft.group_id ?? null,
            slots,
            inProgress,
            outcome
        });
    }

    return { matches, buckets };
};
