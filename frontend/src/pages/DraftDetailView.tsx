import { Component, Show, createMemo, createEffect } from "solid-js";
import { Title } from "@solidjs/meta";
import Draft from "../Draft";
import { useDraftContext } from "../workflows/DraftWorkflow";
import { useCanvasContext } from "../contexts/CanvasContext";
import { CanvasDraft, CanvasGroup } from "../utils/schemas";
import { getRestrictedChampionsByGame } from "../utils/seriesRestrictions";
import { getGroupRestrictedChampionsByDraft } from "../utils/groupRestrictions";
import {
    getRestrictedChampionsForGroup,
    resolveGroupMode
} from "../utils/draftRestrictions";
import { resolveTeamNames } from "../utils/teamNames";

const DraftDetailView: Component = () => {
    const { draft, mutateDraft } = useDraftContext();
    const { canvas, mutateCanvas } = useCanvasContext();

    // Sync draft pick changes back into the canvas resource so the canvas
    // view reflects the latest picks without a refetch when navigating back.
    createEffect(() => {
        const d = draft();
        if (!d) return;
        const picks = [...d.picks];
        const draftId = d.id;

        mutateCanvas((prev) => {
            if (!prev?.drafts) return prev;
            return {
                ...prev,
                drafts: prev.drafts.map((cd: CanvasDraft) =>
                    cd.Draft.id === draftId
                        ? { ...cd, Draft: { ...cd.Draft, picks } }
                        : cd
                )
            };
        });
    });

    // Find the group containing this draft
    const currentGroup = createMemo(() => {
        const draftData = draft();
        if (!draftData) return undefined;

        const groups: CanvasGroup[] = canvas()?.groups ?? [];
        const drafts: CanvasDraft[] = canvas()?.drafts ?? [];

        const canvasDraft = drafts.find((cd) => cd.Draft.id === draftData.id);
        if (!canvasDraft?.group_id) return undefined;

        return groups.find((g) => g.id === canvasDraft.group_id);
    });

    // Team names for the full-screen view. No longer series-only: custom-group
    // defaults and per-card overrides show here too.
    const teamNames = createMemo(() => {
        const draftData = draft();
        if (!draftData) return { blue: undefined, red: undefined };

        const drafts: CanvasDraft[] = canvas()?.drafts ?? [];
        const canvasDraft = drafts.find((cd) => cd.Draft.id === draftData.id);
        if (!canvasDraft) return { blue: undefined, red: undefined };

        const names = resolveTeamNames(canvasDraft, currentGroup());
        return { blue: names.left, red: names.right };
    });

    const siblingDrafts = createMemo(() => {
        const draftData = draft();
        const group = currentGroup();
        if (!draftData || !group) return [];

        const drafts: CanvasDraft[] = canvas()?.drafts ?? [];
        return drafts.filter((cd) => cd.group_id === group.id);
    });

    const effectiveDraftMode = createMemo(() => {
        const group = currentGroup();
        if (!group) return undefined;

        return resolveGroupMode(group);
    });

    const restrictedChampions = createMemo(() => {
        const draftData = draft();
        const group = currentGroup();
        if (!draftData || !group) return [];

        return getRestrictedChampionsForGroup({
            group,
            drafts: siblingDrafts().map((cd) => ({
                id: cd.Draft.id,
                name: cd.Draft.name,
                picks: cd.Draft.picks,
                seriesIndex: cd.Draft.seriesIndex
            })),
            currentDraftId: draftData.id
        });
    });

    const restrictedChampionSourceMap = createMemo(() => {
        const draftData = draft();
        const group = currentGroup();
        const mode = effectiveDraftMode();
        if (!draftData || !group || !mode || mode === "standard") {
            return new Map<string, string>();
        }

        const siblings = siblingDrafts();
        const sourceMap = new Map<string, string>();

        if (group.type === "series") {
            const seriesIndex =
                siblings.find((cd) => cd.Draft.id === draftData.id)?.Draft.seriesIndex ??
                0;

            for (const game of getRestrictedChampionsByGame(
                mode,
                siblings.map((cd) => cd.Draft),
                seriesIndex
            )) {
                const championIds =
                    mode === "ironman"
                        ? [
                              ...game.blueBans,
                              ...game.redBans,
                              ...game.bluePicks,
                              ...game.redPicks
                          ]
                        : [...game.bluePicks, ...game.redPicks];

                for (const championId of championIds) {
                    if (championId && !sourceMap.has(championId)) {
                        sourceMap.set(championId, `Game ${game.gameNumber}`);
                    }
                }
            }

            return sourceMap;
        }

        for (const draftRestriction of getGroupRestrictedChampionsByDraft(
            mode,
            siblings.map((cd) => ({
                id: cd.Draft.id,
                name: cd.Draft.name,
                picks: cd.Draft.picks
            })),
            draftData.id
        )) {
            const championIds =
                mode === "ironman"
                    ? [
                          ...draftRestriction.blueBans,
                          ...draftRestriction.redBans,
                          ...draftRestriction.bluePicks,
                          ...draftRestriction.redPicks
                      ]
                    : [...draftRestriction.bluePicks, ...draftRestriction.redPicks];

            for (const championId of championIds) {
                if (championId && !sourceMap.has(championId)) {
                    sourceMap.set(championId, draftRestriction.draftName);
                }
            }
        }

        return sourceMap;
    });

    const disabledChampions = createMemo(
        () => currentGroup()?.metadata.disabledChampions ?? []
    );

    return (
        <div class="flex-1 overflow-y-auto bg-darius-card-hover bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)] bg-[length:32px_32px]">
            <Title>Draft - First Pick</Title>
            <Show
                when={draft()}
                fallback={
                    <div class="flex h-full items-center justify-center text-darius-text-secondary">
                        Draft not found
                    </div>
                }
            >
                <Draft
                    draft={draft}
                    mutate={mutateDraft}
                    isLocked={draft()?.is_locked}
                    blueTeamName={teamNames().blue}
                    redTeamName={teamNames().red}
                    theme="purple"
                    restrictedChampions={restrictedChampions}
                    disabledChampions={disabledChampions}
                    restrictedChampionSourceMap={restrictedChampionSourceMap}
                />
            </Show>
        </div>
    );
};

export default DraftDetailView;
