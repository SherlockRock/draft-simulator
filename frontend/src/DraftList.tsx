import { useNavigate } from "@solidjs/router";
import { createResource, createSignal, createMemo, createEffect } from "solid-js";
import { fetchDraftList, postNewDraft } from "./utils/actions";
import { SearchableSelect } from "./components/SearchableSelect";

type props = {
    currentDraft: string;
    socket: any;
};

function DraftList(props: props) {
    const navigate = useNavigate();
    const [draftList, { mutate }] = createResource<string[]>(fetchDraftList);
    const [selectText, setSelectText] = createSignal("");

    createEffect(() => {
        setSelectText(props.currentDraft);
    });

    const onValidSelect = (newValue: string) => {
        props.socket.emit("leaveRoom", props.currentDraft);
        navigate(`/${newValue}`);
    };

    const handleNewDraft = async () => {
        const data = await postNewDraft();
        mutate((prev) => [...(prev || []), data]);
        props.socket.emit("leaveRoom", props.currentDraft);
        navigate(`/${data.id}`);
    };

    const drafts = createMemo(() => draftList() || []);

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
        </div>
    );
}

export default DraftList;
