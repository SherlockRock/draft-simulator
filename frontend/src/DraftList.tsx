import { useNavigate } from "@solidjs/router";
import { createSignal, createMemo, Show, Resource, createEffect, Setter } from "solid-js";
import { SearchableSelect } from "./components/SearchableSelect";
import { CanvasListDialog } from "./components/CanvasListDialog";
import { CreateDraftDialog } from "./components/CreateDraftDialog";
import DraftDetails from "./DraftDetails";
import { draft } from "./utils/types";

type props = {
    currentDraft: Resource<draft | null>;
    mutateDraft: Setter<draft | null | undefined>;
    draftList: Resource<any[]>;
    mutateDraftList: any;
    socket: Resource<any>;
};

function DraftList(props: props) {
    const navigate = useNavigate();
    const [selectText, setSelectText] = createSignal("");
    const [showCanvasDialog, setShowCanvasDialog] = createSignal(false);
    const [showCreateDialog, setShowCreateDialog] = createSignal(false);

    createEffect(() => {
        setSelectText(props.currentDraft()?.name ?? "");
    });

    const onValidSelect = (newValue: string) => {
        const selectedDraft = props.draftList()?.find((draft) => draft.name === newValue);
        if (selectedDraft) {
            navigate(`/draft/${selectedDraft.id}`);
        }
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            props.socket().emit("leaveRoom", currentDraft.id);
        }
    };

    const handleNewDraft = () => {
        setShowCreateDialog(true);
    };

    const handleDraftCreated = (draftId: string) => {
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            props.mutateDraft(null);
            props.socket().emit("leaveRoom", currentDraft.id);
        }
        setShowCreateDialog(false);
        navigate(`/draft/${draftId}`);
    };

    const drafts = createMemo(() => {
        return props.draftList()?.map((draft) => draft.name) || [];
    });

    const handleCanvasClick = () => {
        setShowCanvasDialog(true);
    };

    const handleCanvasSelect = (canvasId: string) => {
        navigate(`/canvas/${canvasId}`);
    };

    return (
        <div class="flex w-full flex-col gap-2 pr-2">
            <div class="text-slate-50">Select Draft:</div>
            <SearchableSelect
                placeholder="Select a draft"
                currentlySelected={props.currentDraft()?.name || ""}
                sortOptions={drafts()}
                selectText={selectText()}
                setSelectText={setSelectText}
                onValidSelect={onValidSelect}
            />
            <div class="flex gap-2">
                <button
                    class="flex-1 flex-shrink-0 rounded-md bg-teal-700 px-3 py-2.5 font-medium text-slate-200 hover:bg-teal-400"
                    onClick={handleNewDraft}
                >
                    Create New Draft
                </button>
                <button
                    hidden={!props.currentDraft()}
                    onClick={handleCanvasClick}
                    class="flex-1 flex-shrink-0 rounded-md bg-teal-700 px-3 py-2.5 text-center font-medium text-slate-200 hover:bg-teal-400"
                >
                    Canvas
                </button>
            </div>
            <Show when={props.currentDraft()}>
                <DraftDetails
                    currentDraft={props.currentDraft}
                    mutateDraft={props.mutateDraft}
                    draftList={props.draftList}
                    mutateDraftList={props.mutateDraftList}
                />
            </Show>
            <Show when={showCanvasDialog()}>
                <CanvasListDialog
                    onClose={() => setShowCanvasDialog(false)}
                    currentDraftId={props.currentDraft()?.id || ""}
                    onCanvasSelect={handleCanvasSelect}
                />
            </Show>
            <CreateDraftDialog
                isOpen={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
                onSuccess={handleDraftCreated}
                initialType="standalone"
            />
        </div>
    );
}

export default DraftList;
