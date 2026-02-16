import { Component, Show, createMemo } from "solid-js";
import Draft from "../Draft";
import { useDraftContext } from "../workflows/DraftWorkflow";
import { useCanvasContext } from "../contexts/CanvasContext";
import { CanvasDraft } from "../utils/types";
import { CanvasGroup } from "../utils/schemas";

const DraftDetailView: Component = () => {
    const { draft, mutateDraft } = useDraftContext();
    const { canvas } = useCanvasContext();

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
