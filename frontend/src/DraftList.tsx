import { useNavigate } from "@solidjs/router";
import { createResource, Index } from "solid-js";
import { useSocket } from "./socketProvider";

type draft = {
    id: string;
    picks: string[];
};

type props = {
    currentDraft: string;
};

function DraftList(props: props) {
    const navigate = useNavigate();
    const socket = useSocket();
    const fetchDraftList = async () => {
        const res = await fetch("http://localhost:3000/api/drafts");
        return await res.json();
    };
    const [draftList, { mutate }] = createResource<draft[]>(fetchDraftList);
    // const handleDelete = async (id: string) => {
    //     const res = await fetch(`http://localhost:3000/api/drafts/${id}`, {
    //         method: "DELETE"
    //     });
    //     const result = await res.json();
    //     if ("id" in result && result.id !== "") {
    //         mutate((prev) => prev?.filter((item) => item.id !== result.id));
    //     }
    // };

    const handleNewDraft = async () => {
        const res = await fetch("http://localhost:3000/api/drafts", { method: "POST" });
        const data = await res.json();
        mutate((prev) => [...(prev || []), data]);
        socket.emit("leaveRoom", props.currentDraft);
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
        <div>
            <div class="flex justify-between text-slate-100">
                <p>Draft History:</p>
                <button
                    class="rounded-md rounded-b-none bg-green-600 px-4 py-2 text-sm font-medium"
                    onClick={handleNewDraft}
                >
                    New Draft
                </button>
            </div>
            <ul>
                <Index each={draftList()}>
                    {(each, index) => (
                        <li
                            class={draftListClass(each().id, index)}
                            onClick={() => {
                                socket.emit("leaveRoom", props.currentDraft);
                                navigate(`/${each().id}`);
                            }}
                        >
                            <p>{each().id}</p>
                            <button
                                onClick={async () => {
                                    const res = await fetch(
                                        `http://localhost:3000/api/drafts/${each().id}`,
                                        { method: "DELETE" }
                                    );
                                    const result = await res.json();
                                    if (result) {
                                        mutate((prev) =>
                                            prev?.filter((item) => item.id !== result)
                                        );
                                    }
                                }}
                            >
                                DELETE
                            </button>
                        </li>
                    )}
                </Index>
            </ul>
        </div>
    );
}

export default DraftList;
