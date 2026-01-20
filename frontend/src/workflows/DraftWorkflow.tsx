import {
    Component,
    createResource,
    createEffect,
    createContext,
    useContext,
    Setter,
    Resource,
    Show
} from "solid-js";
import { useParams, RouteSectionProps } from "@solidjs/router";
import { useUser } from "../userProvider";
import { fetchDraftList, fetchDefaultDraft } from "../utils/actions";
import FlowPanel from "../components/FlowPanel";
import DraftList from "../DraftList";
import Chat from "../Chat";
import { VersionFooter } from "../components/VersionFooter";

// Create context for sharing draft state with children
type DraftContextType = {
    draft: Resource<any>;
    mutateDraft: Setter<any>;
    draftList: Resource<any>;
    mutateDraftList: Setter<any>;
};

const DraftContext = createContext<DraftContextType>();

export const useDraftContext = () => {
    const context = useContext(DraftContext);
    if (!context) {
        throw new Error("useDraftContext must be used within DraftWorkFlow");
    }
    return context;
};

const DraftWorkflow: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const accessor = useUser();
    const [user, , socketAccessor] = accessor();

    const [draftList, { mutate: mutateDraftList, refetch: refetchDraftList }] =
        createResource<any[]>(fetchDraftList);

    const [draft, { mutate: mutateDraft, refetch: refetchDraft }] = createResource(
        () => (params.id !== undefined && params.id !== "new" ? String(params.id) : null),
        fetchDefaultDraft
    );

    let previousUser = user();

    createEffect(() => {
        const currentUser = user();
        if (currentUser === undefined) {
            mutateDraftList([]);
            if (draft()?.public !== true) {
                mutateDraft(null);
            }
        } else if (currentUser !== previousUser) {
            refetchDraftList();
            refetchDraft();
        }
        previousUser = currentUser;
    });

    // Clear draft when navigating away from detail view to dashboard
    createEffect(() => {
        if (!params.id) {
            mutateDraft(null);
        }
    });

    // Check if we're on a detail view (has an id param)
    const isDetailView = () => !!params.id;

    return (
        <DraftContext.Provider value={{ draft, mutateDraft, draftList, mutateDraftList }}>
            <div class="flex flex-1 overflow-hidden">
                <Show when={isDetailView()}>
                    <FlowPanel flow="draft">
                        <div class="flex h-full flex-col justify-between gap-4 pt-4">
                            <DraftList
                                currentDraft={draft}
                                mutateDraft={mutateDraft}
                                draftList={draftList}
                                mutateDraftList={mutateDraftList}
                                socket={socketAccessor}
                            />
                            <div class="flex-1">
                                <Chat
                                    currentDraft={params.id || ""}
                                    socket={socketAccessor()}
                                />
                            </div>
                            <VersionFooter />
                        </div>
                    </FlowPanel>
                </Show>
                {/* Child routes (dashboard or detail view) render here */}
                {props.children}
            </div>
        </DraftContext.Provider>
    );
};

export default DraftWorkflow;
