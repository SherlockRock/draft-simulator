import { Component, Show } from "solid-js";
import CreateDraft from "../CreateDraft";
import Draft from "../Draft";
import ConnectionBanner from "../ConnectionBanner";
import { useDraftContext } from "../workflows/DraftWorkflow";

const DraftDetailView: Component = () => {
    const { draft, mutateDraft, draftList, mutateDraftList } = useDraftContext();

    return (
        <div class="flex-1 overflow-y-auto">
            <ConnectionBanner />
            <Show
                when={draft()}
                fallback={<CreateDraft draftList={draftList} mutate={mutateDraftList} />}
            >
                <Draft draft={draft} mutate={mutateDraft} />
            </Show>
        </div>
    );
};

export default DraftDetailView;
