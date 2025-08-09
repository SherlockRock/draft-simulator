import { useNavigate } from "@solidjs/router";
import { createSignal, createMemo, Show, Resource } from "solid-js";
import { SearchableSelect } from "./components/SearchableSelect";
import DraftDetails from "./DraftDetails";

type props = {
    currentDraft: Resource<any>;
    mutateDraft: any;
    draftList: Resource<any[]>;
    mutateDraftList: any;
    socket: Resource<any>;
};

function DraftList(props: props) {
    const navigate = useNavigate();
    const [selectText, setSelectText] = createSignal("");

    const onValidSelect = (newValue: string) => {
        const selectedDraft = props.draftList()?.find((draft) => draft.name === newValue);
        if (selectedDraft) {
            navigate(`/${selectedDraft.id}`);
        }
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            props.socket().emit("leaveRoom", currentDraft.id);
        }
    };

    const handleNewDraft = () => {
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            props.mutateDraft(null);
            props.socket().emit("leaveRoom", currentDraft.id);
        }
        navigate(`/`);
    };

    const drafts = createMemo(() => {
        console.log("Drafts:", props.draftList());
        return props.draftList()?.map((draft) => draft.name) || [];
    });

    return (
        <div class="flex w-full flex-col gap-2">
            <div class="text-gray-300">Select Draft:</div>
            <SearchableSelect
                sortOptions={drafts()}
                selectText={selectText()}
                setSelectText={setSelectText}
                onValidSelect={onValidSelect}
            />
            <button
                class="flex-shrink-0 rounded-md bg-green-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-green-700"
                onClick={handleNewDraft}
            >
                New Draft
            </button>
            <Show when={props.currentDraft()}>
                <DraftDetails
                    currentDraft={props.currentDraft}
                    mutateDraft={props.mutateDraft}
                    draftList={props.draftList}
                    mutateDraftList={props.mutateDraftList}
                />
            </Show>
        </div>
    );
}

export default DraftList;
