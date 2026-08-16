import {
    appearsInScope,
    countsInScope,
    effectiveGameType,
    resolvesTeamNames,
    type SearchScope
} from "./gameClassification";
import type { CanvasDraft, CanvasGroup } from "./schemas";

export type SlotPhase = "ban" | "pick";
export type SlotSide = "blue" | "red";
export type SearchBucket = "pickedBy" | "pickedAgainst" | "bannedBy" | "bannedAgainst";

export type SlotKind = { phase: SlotPhase; side: SlotSide };

export type SearchQuery = {
    /** Canonical champion id (e.g. "Jinx"); null/"" = no champion (team-only when teamName set). */
    championId: string | null;
    /** Case-insensitive team-name filter; null = champion-only search. */
    teamName: string | null;
    /**
     * Narrows to head-to-head games (design R1); only meaningful with teamName
     * set — the engine ignores it when teamName is null, and the UI disables
     * the field until a team is chosen. teamName stays the perspective anchor:
     * buckets, outcome and teamRecord keep their one-team semantics exactly.
     */
    opponentTeamName: string | null;
    /** Restrict match highlights to one bucket; null = all buckets. */
    bucket: SearchBucket | null;
    /**
     * Narrows the search to one class of game. Applies to EVERY query, but "all"
     * means something different either side of a team filter:
     *
     * - with a team (aggregation): "all" is the counted rule — scratch and
     *   unclassified drafts are excluded, so records stay behaviour-preserving.
     * - without one (navigation): "all" is no filter, so champion-only search
     *   still spans loose cards and unclassified groups.
     *
     * A named scope means the same thing on both sides. See countsInScope and
     * appearsInScope.
     */
    scope: SearchScope;
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
    /**
     * Side the filtered team played in this draft; null without a team filter.
     * Carried so result rows can mark A's side (R2) and so the deferred side
     * filter stays a one-guard diff.
     */
    teamSide: SlotSide | null;
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
    /** The team's canvas-wide W/L record; only set in team-only mode (no champion). */
    teamRecord: BucketSummary | null;
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

/**
 * Effective team names for a group: the linked Team entity's name wins, else
 * the free-text metadata string. Keeps unlinked groups and anonymous/local
 * canvases (no Team entity) working via the fallback.
 *
 * CLASSIFIED GROUPS ONLY, deliberately. Search aggregates per-team win/loss
 * records across every draft it can attribute to a team, so an unclassified
 * custom group must not resolve names at all — otherwise throwaway drafts
 * attach themselves to a real team and its dropdown fills with junk.
 *
 * Note this admits `scratch`, which does NOT count. Resolving names and
 * counting are two different questions: a scratch group has to resolve names so
 * that a scratch-scoped search can find its games, and it is then excluded by
 * the scope filter under every other scope. Folding the two together — as an
 * earlier revision did — makes a scratch scope structurally impossible, because
 * the team never matches a side and never reaches the filter.
 *
 * See docs/designs/canvas-game-classification-design.md (D6/D8).
 */
export const resolveGroupTeamNames = (
    group: CanvasGroup
): { team1: string | null; team2: string | null } => {
    if (!resolvesTeamNames(group)) return { team1: null, team2: null };
    const team1 =
        group.Team1?.name?.trim() || group.metadata.blueTeamName?.trim() || null;
    const team2 = group.Team2?.name?.trim() || group.metadata.redTeamName?.trim() || null;
    return { team1, team2 };
};

export const teamSideInDraft = (
    draft: CanvasDraft,
    group: CanvasGroup | undefined,
    teamName: string
): SlotSide | null => {
    if (!group) return null;
    const target = normalizeName(teamName);
    if (!target) return null;
    const { team1, team2 } = resolveGroupTeamNames(group);
    const t1 = normalizeName(team1 ?? undefined);
    const t2 = normalizeName(team2 ?? undefined);
    const blueSideTeam = draft.Draft.blueSideTeam ?? 1;
    if (t1 === target) return blueSideTeam === 1 ? "blue" : "red";
    if (t2 === target) return blueSideTeam === 1 ? "red" : "blue";
    return null;
};

export const bucketFor = (kind: SlotKind, teamSide: SlotSide): SearchBucket => {
    if (kind.phase === "pick") {
        return kind.side === teamSide ? "pickedBy" : "pickedAgainst";
    }
    return kind.side === teamSide ? "bannedBy" : "bannedAgainst";
};

/**
 * Distinct team names across all groups (case-insensitive, first casing wins),
 * sorted.
 *
 * Scope-aware: a team is only offered if it appears in a group the current scope
 * would actually search. Without this, selecting scope "scratch" would still
 * list every scrim-only team and hand you an empty record with no explanation —
 * and now that scratch groups resolve names, the reverse would happen under
 * "all".
 */
export const getTeamNameOptions = (
    groups: readonly CanvasGroup[],
    scope: SearchScope = "all"
): string[] => {
    const seen = new Map<string, string>();
    for (const group of groups) {
        if (!countsInScope(effectiveGameType(undefined, group), scope)) continue;
        const { team1, team2 } = resolveGroupTeamNames(group);
        for (const raw of [team1, team2]) {
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

/**
 * R1/R3: the opponent filter narrows to head-to-head games. It resolves via
 * group identity exactly like the primary team filter — per-card name
 * overrides never match — and a draft where the opponent resolves to the SAME
 * side as the team (opponent === team) can never pass.
 */
const passesOpponentFilter = (
    canvasDraft: CanvasDraft,
    group: CanvasGroup | undefined,
    opponentTeamName: string | null,
    teamSide: SlotSide
): boolean => {
    if (opponentTeamName === null) return true;
    const oppSide = teamSideInDraft(canvasDraft, group, opponentTeamName);
    return oppSide !== null && oppSide !== teamSide;
};

/**
 * Team-only search: no champion, one card-level DraftMatch per draft the team
 * played, plus the team's canvas-wide W/L record. `slots` is empty because the
 * highlight is card-level (there is no champion to mark).
 */
const computeTeamOnlyResults = (
    drafts: readonly CanvasDraft[],
    groupById: Map<string, CanvasGroup>,
    teamName: string,
    opponentTeamName: string | null,
    scope: SearchScope
): SearchResults => {
    const matches: DraftMatch[] = [];
    const teamRecord = emptyBucketSummary();

    for (const canvasDraft of drafts) {
        const group = canvasDraft.group_id
            ? groupById.get(canvasDraft.group_id)
            : undefined;
        // Unconditional here: this path only runs under a team filter.
        if (!countsInScope(effectiveGameType(canvasDraft, group), scope)) continue;
        const teamSide = teamSideInDraft(canvasDraft, group, teamName);
        if (teamSide === null) continue;
        if (!passesOpponentFilter(canvasDraft, group, opponentTeamName, teamSide)) continue;

        const inProgress = isDraftInProgress(canvasDraft);
        const outcome = computeOutcome(canvasDraft, teamSide, inProgress);

        teamRecord.games += 1;
        if (inProgress) teamRecord.inProgress += 1;
        else if (outcome === "win") teamRecord.wins += 1;
        else if (outcome === "loss") teamRecord.losses += 1;
        else teamRecord.noResult += 1;

        matches.push({
            draftId: canvasDraft.Draft.id,
            groupId: canvasDraft.group_id ?? null,
            teamSide,
            slots: [],
            inProgress,
            outcome
        });
    }

    return { matches, buckets: null, teamRecord };
};

export const computeSearchResults = (
    drafts: readonly CanvasDraft[],
    groups: readonly CanvasGroup[],
    query: SearchQuery,
    resolvePick: (pickValue: string) => string
): SearchResults => {
    const groupById = new Map(groups.map((group) => [group.id, group]));

    const championId = query.championId;
    if (championId === null || championId === "") {
        if (query.teamName === null) {
            return { matches: [], buckets: null, teamRecord: null };
        }
        return computeTeamOnlyResults(
            drafts,
            groupById,
            query.teamName,
            query.opponentTeamName,
            query.scope
        );
    }

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

        // Scope applies to EVERY query, but means different things either side
        // of a team filter. Aggregating: "all" is the counted rule. Navigating:
        // "all" is no filter at all, so a champion-only search still spans loose
        // cards and unclassified groups — most of a typical canvas.
        const effective = effectiveGameType(canvasDraft, group);
        const inScope =
            query.teamName !== null
                ? countsInScope(effective, query.scope)
                : appearsInScope(effective, query.scope);
        if (!inScope) continue;

        let teamSide: SlotSide | null = null;
        if (query.teamName !== null) {
            teamSide = teamSideInDraft(canvasDraft, group, query.teamName);
            if (teamSide === null) continue;
            if (!passesOpponentFilter(canvasDraft, group, query.opponentTeamName, teamSide))
                continue;
        }

        const allSlots: MatchSlot[] = [];
        canvasDraft.Draft.picks.forEach((value, index) => {
            if (value === "" || resolvePick(value) !== championId) return;
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
            teamSide,
            slots,
            inProgress,
            outcome
        });
    }

    return { matches, buckets, teamRecord: null };
};

/** The opponent dropdown: the same scope-aware list minus the selected team (R1). */
export const getOpponentNameOptions = (
    groups: readonly CanvasGroup[],
    scope: SearchScope,
    teamName: string
): string[] => {
    const target = teamName.trim().toLowerCase();
    return getTeamNameOptions(groups, scope).filter(
        (name) => name.trim().toLowerCase() !== target
    );
};

const parseTime = (iso: string | undefined): number => {
    if (!iso) return 0;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? 0 : time;
};

type MatchSortKey = {
    blockTime: number;
    blockId: string;
    seriesIndex: number;
    draftTime: number;
    draftId: string;
};

/**
 * Stable deterministic result order (R10): blocks newest-first, where a block
 * is a group (createdAt) or a loose card (its own single-row block); within a
 * group, ascending seriesIndex, then draft createdAt, then draftId. Never
 * match-discovery order, never world position — rows must not jump under the
 * reader when cards move or picks land.
 */
export const sortDraftMatches = (
    matches: readonly DraftMatch[],
    drafts: readonly CanvasDraft[],
    groups: readonly CanvasGroup[]
): DraftMatch[] => {
    const draftById = new Map(drafts.map((cd) => [cd.Draft.id, cd]));
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const keyFor = (match: DraftMatch): MatchSortKey => {
        const cd = draftById.get(match.draftId);
        const group = match.groupId !== null ? groupById.get(match.groupId) : undefined;
        const draftTime = parseTime(cd?.Draft.createdAt ?? cd?.createdAt);
        if (group) {
            return {
                blockTime: parseTime(group.createdAt),
                blockId: group.id,
                seriesIndex: cd?.Draft.seriesIndex ?? Number.MAX_SAFE_INTEGER,
                draftTime,
                draftId: match.draftId
            };
        }
        return {
            blockTime: draftTime,
            blockId: match.draftId,
            seriesIndex: 0,
            draftTime,
            draftId: match.draftId
        };
    };
    return matches
        .map((match) => ({ match, key: keyFor(match) }))
        .sort(
            (a, b) =>
                b.key.blockTime - a.key.blockTime ||
                a.key.blockId.localeCompare(b.key.blockId) ||
                a.key.seriesIndex - b.key.seriesIndex ||
                a.key.draftTime - b.key.draftTime ||
                a.key.draftId.localeCompare(b.key.draftId)
        )
        .map((entry) => entry.match);
};

export type ScopeHint = { scope: SearchScope; games: number };

const NAMED_SCOPES: readonly SearchScope[] = ["official", "scrim", "scratch"];

/**
 * R5: distinguishes "never played" from "the scope is hiding them". Callers
 * run this ONLY when the primary matchup result is empty — it re-runs the
 * search once per other named scope (O(3 · drafts · 20), trivial).
 *
 * The WHOLE query is forwarded (championId and bucket included), so a hint's
 * count always describes the same population as the empty-state sentence
 * above it: "no Jinx games between A and B … 2 games exist under Scrims"
 * means 2 JINX games. Stripping the champion here would make the hint claim
 * games the sentence just denied.
 */
export const computeMatchupScopeHint = (
    drafts: readonly CanvasDraft[],
    groups: readonly CanvasGroup[],
    query: SearchQuery,
    resolvePick: (pickValue: string) => string
): ScopeHint[] => {
    if (query.teamName === null || query.opponentTeamName === null) return [];
    const hints: ScopeHint[] = [];
    for (const scope of NAMED_SCOPES) {
        if (scope === query.scope) continue;
        const games = computeSearchResults(drafts, groups, { ...query, scope }, resolvePick)
            .matches.length;
        if (games > 0) hints.push({ scope, games });
    }
    return hints;
};
