import { Component, Show, createMemo, createEffect } from "solid-js";
import Draft from "../Draft";
import { useDraftContext } from "../workflows/DraftWorkflow";
import { useCanvasContext } from "../contexts/CanvasContext";
import { CanvasDraft } from "../utils/types";
import { CanvasGroup } from "../utils/schemas";

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

    // Find the group containing this draft and compute team names
    const teamNames = createMemo(() => {
        const draftData = draft();
        if (!draftData) return { blue: undefined, red: undefined };

        const groups = (canvas()?.groups ?? []) as CanvasGroup[];
        const drafts = (canvas()?.drafts ?? []) as CanvasDraft[];

        // Find which group this draft belongs to
        const canvasDraft = drafts.find((cd) => cd.Draft.id === draftData.id);
        if (!canvasDraft?.group_id) return { blue: undefined, red: undefined };

        const group = groups.find((g) => g.id === canvasDraft.group_id);
        if (!group || group.type !== "series") return { blue: undefined, red: undefined };

        // Compute display names based on blueSideTeam
        const bst = canvasDraft.Draft.blueSideTeam ?? 1;
        return {
            blue: bst === 1 ? group.metadata.blueTeamName : group.metadata.redTeamName,
            red: bst === 1 ? group.metadata.redTeamName : group.metadata.blueTeamName
        };
    });

    return (
        <div class="flex-1 overflow-y-auto">
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
