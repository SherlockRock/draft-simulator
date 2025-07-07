import { useNavigate } from "@solidjs/router";
import { createSignal, createMemo, Show } from "solid-js";
import { SearchableSelect } from "./components/SearchableSelect";
import DraftDetails from "./DraftDetails";

type props = {
    currentDraft: any;
    mutateDraft: any;
    draftList: any[];
    mutateDraftList: any;
    socket: any;
};

function DraftList(props: props) {
    const navigate = useNavigate();
    const [selectText, setSelectText] = createSignal("");

    const onValidSelect = (newValue: string) => {
        const selectedDraft = props.draftList?.find((draft) => draft.name === newValue);
        if (selectedDraft) {
            if (props.currentDraft) {
                props.socket.emit("leaveRoom", props.currentDraft.id);
            }
            navigate(`/${selectedDraft.id}`);
        }
    };

    const handleNewDraft = () => {
        if (props.currentDraft) {
            props.mutateDraft(null);
            props.socket.emit("leaveRoom", props.currentDraft.id);
        }
        navigate(`/`);
    };

    const drafts = createMemo(() => props.draftList?.map((draft) => draft.name) || []);

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
            <Show when={props.currentDraft}>
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
