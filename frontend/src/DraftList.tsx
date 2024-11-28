import { useNavigate } from "@solidjs/router";
import { createResource, Index } from "solid-js";

type draft = {
    id: string;
    picks: string[];
};

function DraftList() {
    const navigate = useNavigate();
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

    const handleClick = async () => {
        const res = await fetch("http://localhost:3000/api/drafts", { method: "POST" });
        const data = await res.json();
        mutate((prev) => [...(prev || []), data]);
        navigate(`/${data.id}`);
    };

    return (
        <div>
            <div class="flex justify-between text-slate-100">
                <p>Draft History:</p>
                <button class="bg-green-600" onClick={handleClick}>
                    New Draft
                </button>
            </div>
            <ul>
                <Index each={draftList()}>
                    {(each, index) => (
                        <li
                            class={
                                index % 2 === 0
                                    ? "flex justify-between bg-slate-100 text-slate-700"
                                    : "flex justify-between bg-slate-700 text-slate-100"
                            }
                            onClick={() => navigate(`/${each().id}`)}
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
