import {
    Component,
    createResource,
    createEffect,
    createContext,
    useContext,
    Setter,
    Resource
} from "solid-js";
import { useParams, RouteSectionProps } from "@solidjs/router";
import { useUser } from "../userProvider";
import { fetchDefaultDraft } from "../utils/actions";

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
    const accessor = useUser();
    const [user] = accessor();

    const [draft, { mutate: mutateDraft, refetch: refetchDraft }] = createResource(
        () =>
            params.draftId
                ? { draftId: String(params.draftId), canvasId: params.id }
                : null,
        (args) => fetchDefaultDraft(args?.draftId ?? null, args?.canvasId)
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
            {props.children}
        </DraftContext.Provider>
    );
};

export default DraftWorkflow;
