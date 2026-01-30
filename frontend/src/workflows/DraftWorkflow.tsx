import {
    Component,
    createResource,
    createEffect,
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
import Chat from "../Chat";
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
    const [user, , socketAccessor] = accessor();

    const [draft, { mutate: mutateDraft, refetch: refetchDraft }] = createResource(
        () => (params.id ? String(params.id) : null),
        fetchDefaultDraft
    );

    // Fetch canvas context once we have a draft
    const [canvasContext] = createResource(
        () => (params.id ? String(params.id) : null),
        fetchCanvasSiblingDrafts
    );

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

                        {/* Sibling drafts list */}
                        <Show when={canvasContext()?.drafts?.length}>
                            <div class="flex flex-col gap-1">
                                <div class="px-3 text-xs font-medium uppercase tracking-wider text-slate-400">
                                    Canvas Drafts
                                </div>
                                <div class="flex flex-col gap-0.5 overflow-y-auto">
                                    <For each={canvasContext()!.drafts}>
                                        {(siblingDraft: any) => (
                                            <button
                                                onClick={() => navigate(`/draft/${siblingDraft.Draft?.id || siblingDraft.id}`)}
                                                class={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                                                    (siblingDraft.Draft?.id || siblingDraft.id) === params.id
                                                        ? "bg-slate-600 text-slate-50"
                                                        : "text-slate-300 hover:bg-slate-700"
                                                }`}
                                            >
                                                {siblingDraft.Draft?.name || siblingDraft.name}
                                            </button>
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

                        {/* Chat */}
                        <div class="flex-1">
                            <Chat
                                currentDraft={params.id || ""}
                                socket={socketAccessor()}
                            />
                        </div>
                        <VersionFooter />
                    </div>
                </FlowPanel>
                {props.children}
            </div>
        </DraftContext.Provider>
    );
};

export default DraftWorkflow;
