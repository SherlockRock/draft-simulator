import { useNavigate } from "@solidjs/router";
import { createResource, Index, createSignal } from "solid-js";
import { deleteDraft, fetchDraftList, postNewDraft } from "./utils/actions";

type draft = {
    id: string;
    picks: string[];
};

type props = {
    currentDraft: string;
    socket: any;
};

function DraftList(props: props) {
    const navigate = useNavigate();
    const [draftList, { mutate }] = createResource<draft[]>(fetchDraftList);
    const [isExpanded, setIsExpanded] = createSignal(false);

    const handleNewDraft = async () => {
        const data = await postNewDraft();
        mutate((prev) => [...(prev || []), data]);
        props.socket.emit("leaveRoom", props.currentDraft);
        navigate(`/${data.id}`);
    };

    const draftListClass = (id: string, index: number) => {
        let text = "";
        if (props.currentDraft === id) {
            text = "text-red-500";
        } else {
            text = index % 2 === 0 ? "text-gray-700" : "text-slate-100";
        }
        if (index % 2 === 0) {
            return `${text} flex justify-between bg-slate-100`;
        }
        return `${text} flex justify-between bg-gray-700`;
    };

    return (
        <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
                <button
                    class="flex items-center gap-2 text-slate-100"
                    onClick={() => setIsExpanded(!isExpanded())}
                >
                    <span>Draft History</span>
                    <svg
                        class={`h-4 w-4 transform transition-transform ${
                            isExpanded() ? "rotate-180" : ""
                        }`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M19 9l-7 7-7-7"
                        />
                    </svg>
                </button>
                <button
                    class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
                    onClick={handleNewDraft}
                >
                    New Draft
                </button>
            </div>
            {isExpanded() && (
                <div class="max-h-48 overflow-y-auto rounded border border-gray-700">
                    <ul>
                        <Index each={draftList()}>
                            {(each, index) => (
                                <li
                                    class={draftListClass(each().id, index)}
                                    onClick={() => {
                                        props.socket.emit(
                                            "leaveRoom",
                                            props.currentDraft
                                        );
                                        navigate(`/${each().id}`);
                                    }}
                                >
                                    <p class="px-2 py-1">{each().id}</p>
                                    <button
                                        class="px-2 py-1 text-red-500 hover:bg-red-500 hover:text-white"
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            const result = await deleteDraft(each().id);
                                            if (result) {
                                                mutate((prev) =>
                                                    prev?.filter(
                                                        (item) => item.id !== result
                                                    )
                                                );
                                            }
                                        }}
                                    >
                                        ×
                                    </button>
                                </li>
                            )}
                        </Index>
                    </ul>
                </div>
            )}
        </div>
    );
}

export default DraftList;
