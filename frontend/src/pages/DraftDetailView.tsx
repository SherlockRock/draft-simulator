import { Component, Show, createMemo, createEffect } from "solid-js";
import { Title } from "@solidjs/meta";
import Draft from "../Draft";
import { useDraftContext } from "../workflows/DraftWorkflow";
import { useCanvasContext } from "../contexts/CanvasContext";
import { CanvasDraft, CanvasGroup } from "../utils/schemas";

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

        const groups = (canvas()?.groups ?? []) as CanvasGroup[];
        const drafts = (canvas()?.drafts ?? []) as CanvasDraft[];

        const canvasDraft = drafts.find((cd) => cd.Draft.id === draftData.id);
        if (!canvasDraft?.group_id) return undefined;

        return groups.find((g) => g.id === canvasDraft.group_id);
    });

    // Compute team names from series groups
    const teamNames = createMemo(() => {
        const draftData = draft();
        const group = currentGroup();
        if (!draftData || !group || group.type !== "series") {
            return { blue: undefined, red: undefined };
        }

        const drafts = (canvas()?.drafts ?? []) as CanvasDraft[];
        const canvasDraft = drafts.find((cd) => cd.Draft.id === draftData.id);
        const bst = canvasDraft?.Draft.blueSideTeam ?? 1;
        return {
            blue: bst === 1 ? group.metadata.blueTeamName : group.metadata.redTeamName,
            red: bst === 1 ? group.metadata.redTeamName : group.metadata.blueTeamName
        };
    });

    return (
        <div class="flex-1 overflow-y-auto bg-slate-700 bg-[radial-gradient(circle,rgba(148,163,184,0.15)_1px,transparent_1px)] bg-[length:32px_32px]">
            <Title>Draft - First Pick</Title>
            <Show
                when={draft()}
                fallback={
                    <div class="flex h-full items-center justify-center text-slate-400">
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
                />
            </Show>
        </div>
    );
};

export default DraftDetailView;
