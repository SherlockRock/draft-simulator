import {
    Component,
    createResource,
    createEffect,
    createMemo,
    createContext,
    useContext,
    Setter,
    Resource,
    Show,
    For
} from "solid-js";
import { useParams, useNavigate, RouteSectionProps } from "@solidjs/router";
import { useUser } from "../userProvider";
import { fetchDefaultDraft, fetchCanvasSiblingDrafts } from "../utils/actions";
import FlowPanel from "../components/FlowPanel";
import { VersionFooter } from "../components/VersionFooter";

// Keep the context — DraftDetailView still uses it
type DraftContextType = {
    draft: Resource<any>;
    mutateDraft: Setter<any>;
};

const DraftContext = createContext<DraftContextType>();

export const useDraftContext = () => {
    const context = useContext(DraftContext);
    if (!context) {
        throw new Error("useDraftContext must be used within DraftWorkflow");
    }
    return context;
};

const DraftWorkflow: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const navigate = useNavigate();
    const accessor = useUser();
    const [user] = accessor();

    const [draft, { mutate: mutateDraft, refetch: refetchDraft }] = createResource(
        () => (params.id ? String(params.id) : null),
        fetchDefaultDraft
    );

    // Fetch canvas context once we have a draft
    const [canvasContext] = createResource(
        () => (params.id ? String(params.id) : null),
        fetchCanvasSiblingDrafts
    );

    const groups = createMemo(() => canvasContext()?.groups || []);

    const ungroupedDrafts = createMemo(() => {
        const drafts = canvasContext()?.drafts || [];
        return drafts.filter((d: any) => !d.group_id);
    });

    const getDraftsForGroup = (groupId: string) => {
        const drafts = canvasContext()?.drafts || [];
        const groupDrafts = drafts.filter((d: any) => d.group_id === groupId);
        const group = groups().find((g: any) => g.id === groupId);
        if (group?.type === "series") {
            groupDrafts.sort(
                (a: any, b: any) =>
                    (a.Draft?.seriesIndex ?? 0) - (b.Draft?.seriesIndex ?? 0)
            );
        }
        return groupDrafts;
    };

    let previousUser = user();

    createEffect(() => {
        const currentUser = user();
        if (currentUser === undefined) {
            if (draft()?.public !== true) {
                mutateDraft(null);
            }
        } else if (currentUser !== previousUser) {
            refetchDraft();
        }
        previousUser = currentUser;
    });

    const draftId = (d: any) => d.Draft?.id || d.id;
    const draftName = (d: any) => d.Draft?.name || d.name;

    return (
        <DraftContext.Provider value={{ draft, mutateDraft }}>
            <div class="flex flex-1 overflow-hidden">
                <FlowPanel flow="draft">
                    <div class="flex h-full flex-col gap-4 pt-4">
                        {/* Back to canvas link */}
                        <Show when={canvasContext()?.canvas}>
                            <button
                                onClick={() => navigate(`/canvas/${canvasContext()!.canvas!.id}`)}
                                class="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
                            >
                                <span>&larr;</span>
                                <span>Back to {canvasContext()!.canvas!.name}</span>
                            </button>
                        </Show>

                        {/* Sibling drafts list — matches canvas sidebar styling */}
                        <Show when={canvasContext()?.drafts?.length}>
                            <div class="flex min-h-0 flex-col gap-2 overflow-y-auto px-2">
                                <h3 class="text-sm font-semibold text-slate-300">
                                    Drafts in Canvas
                                </h3>
                                <div class="flex flex-col gap-1">
                                    {/* Grouped drafts */}
                                    <For each={groups()}>
                                        {(group: any) => (
                                            <div class="flex flex-col gap-1">
                                                <div
                                                    class="flex cursor-pointer items-center gap-2 rounded-md bg-slate-600 px-2 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-500"
                                                    onClick={() => navigate(`/canvas/${canvasContext()!.canvas!.id}`)}
                                                >
                                                    <span class="text-slate-400">
                                                        {group.type === "series" ? "Series" : "Group"}
                                                    </span>
                                                    <span class="truncate">
                                                        {group.name}
                                                    </span>
                                                </div>
                                                <For each={getDraftsForGroup(group.id)}>
                                                    {(canvasDraft: any) => (
                                                        <div
                                                            class={`ml-3 cursor-pointer rounded-md px-3 py-2 text-sm transition-colors ${
                                                                draftId(canvasDraft) === params.id
                                                                    ? "bg-slate-600 text-slate-50"
                                                                    : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                                                            }`}
                                                            onClick={() => navigate(`/draft/${draftId(canvasDraft)}`)}
                                                        >
                                                            {draftName(canvasDraft)}
                                                        </div>
                                                    )}
                                                </For>
                                            </div>
                                        )}
                                    </For>
                                    {/* Ungrouped drafts */}
                                    <For each={ungroupedDrafts()}>
                                        {(canvasDraft: any) => (
                                            <div
                                                class={`cursor-pointer rounded-md px-3 py-2 text-sm transition-colors ${
                                                    draftId(canvasDraft) === params.id
                                                        ? "bg-slate-600 text-slate-50"
                                                        : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                                                }`}
                                                onClick={() => navigate(`/draft/${draftId(canvasDraft)}`)}
                                            >
                                                {draftName(canvasDraft)}
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </div>
                        </Show>

                        {/* Orphaned draft message */}
                        <Show when={canvasContext() && !canvasContext()?.canvas}>
                            <div class="px-3 text-sm text-slate-400">
                                This draft is not attached to a canvas.
                            </div>
                        </Show>

                        <div class="flex-1" />
                        <VersionFooter />
                    </div>
                </FlowPanel>
                {props.children}
            </div>
        </DraftContext.Provider>
    );
};

export default DraftWorkflow;
