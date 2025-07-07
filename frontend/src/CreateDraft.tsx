import { createSignal, Resource, Setter } from "solid-js";
import { postNewDraft } from "./utils/actions";
import { useNavigate } from "@solidjs/router";

type props = {
    draftList: Resource<any>;
    mutate: Setter<any>;
};

function CreateDraft(props: props) {
    const [name, setName] = createSignal("New Draft");
    const [isPublic, setIsPublic] = createSignal(true);
    const navigate = useNavigate();

    const handleCreateDraft = async () => {
        const newDraft = await postNewDraft({ name: name(), public: isPublic() });
        props.mutate([...props.draftList(), newDraft]);
        navigate(`/${newDraft.id}`);
    };

    return (
        <div class="flex h-full flex-col items-center justify-center">
            <h2 class="mb-4 text-2xl font-bold text-white">Create a New Draft</h2>
            <div class="w-full max-w-xs">
                <div class="mb-4">
                    <label
                        class="mb-2 block text-sm font-bold text-white"
                        for="draft-name"
                    >
                        Draft Name
                    </label>
                    <input
                        id="draft-name"
                        type="text"
                        value={name()}
                        onInput={(e) => setName(e.currentTarget.value)}
                        class="focus:shadow-outline w-full appearance-none rounded border px-3 py-2 leading-tight text-gray-700 shadow focus:outline-none"
                    />
                </div>
                <div class="mb-6">
                    <label class="flex items-center">
                        <input
                            type="checkbox"
                            checked={isPublic()}
                            onChange={(e) => setIsPublic(e.currentTarget.checked)}
                            class="mr-2"
                        />
                        <span class="text-sm text-white">Public</span>
                    </label>
                </div>
                <div class="flex items-center justify-between">
                    <button
                        onClick={handleCreateDraft}
                        class="focus:shadow-outline rounded bg-blue-500 px-4 py-2 font-bold text-white hover:bg-blue-700 focus:outline-none"
                        type="button"
                    >
                        Create Draft
                    </button>
                </div>
            </div>
        </div>
    );
}

export default CreateDraft;
