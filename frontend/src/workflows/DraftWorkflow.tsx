import { createResource, createEffect, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { useUser } from "../userProvider";
import { fetchDefaultDraft, fetchDraftList } from "../utils/actions";
import NavBar from "../NavBar";
import DraftList from "../DraftList";
import Chat from "../Chat";
import CreateDraft from "../CreateDraft";
import Draft from "../Draft";
import ConnectionBanner from "../ConnectionBanner";
import { VersionFooter } from "../components/VersionFooter";

const DraftWorkflow = () => {
    const params = useParams();
    const accessor = useUser();
    const [user, , socketAccessor] = accessor();

    const [draft, { mutate: mutateDraft, refetch: refetchDraft }] = createResource(
        () => (params.id !== undefined ? String(params.id) : null),
        fetchDefaultDraft
    );
    const [draftList, { mutate: mutateDraftList, refetch: refetchDraftList }] =
        createResource<any[]>(fetchDraftList);

    let previousUser = user();

    createEffect(() => {
        const currentUser = user();
        if (currentUser === undefined) {
            mutateDraftList([]);
        } else if (currentUser !== previousUser) {
            refetchDraftList();
            refetchDraft();
        }
        previousUser = currentUser;
    });

    const clearDraftList = () => {
        mutateDraftList([]);
        if (draft()?.public !== true) {
            mutateDraft(null);
        }
    };

    return (
        <div class="flex h-full gap-2">
            <NavBar handleLogOut={clearDraftList}>
                <DraftList
                    currentDraft={draft}
                    mutateDraft={mutateDraft}
                    draftList={draftList}
                    mutateDraftList={mutateDraftList}
                    socket={socketAccessor}
                />
                <div class="flex-1">
                    <Chat currentDraft={draft()?.id || ""} socket={socketAccessor()} />
                </div>
                <VersionFooter />
            </NavBar>
            <div class="flex-1 overflow-y-auto">
                <ConnectionBanner />
                <Show
                    when={draft()}
                    fallback={
                        <CreateDraft draftList={draftList} mutate={mutateDraftList} />
                    }
                >
                    <Draft draft={draft} mutate={mutateDraft} />
                </Show>
            </div>
        </div>
    );
};

export default DraftWorkflow;
