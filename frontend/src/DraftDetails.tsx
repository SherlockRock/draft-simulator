import { createSignal, createMemo, createEffect, Show, Resource } from "solid-js";
import { editDraft, generateShareLink } from "./utils/actions";
import KeyEvent, { Key } from "./KeyEvent";
import { DOMElement } from "solid-js/jsx-runtime";
import { useUser } from "./userProvider";

type props = {
    currentDraft: Resource<any>;
    mutateDraft: any;
    draftList: Resource<any[]>;
    mutateDraftList: any;
};

function DraftDetails(props: props) {
    const accessor = useUser();
    const userAccessor = accessor()[0];
    const [isFocused, setIsFocused] = createSignal(false);
    const [isEditingName, setIsEditingName] = createSignal(false);
    const [draftName, setDraftName] = createSignal("");

    createEffect(() => {
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            setDraftName(currentDraft.name);
        }
    });

    const handleTogglePublic = async () => {
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            const updatedDraft = await editDraft(currentDraft.id, {
                public: !currentDraft.public
            });
            props.mutateDraft(updatedDraft);
        }
    };

    const handleNameChange = async (
        e?: SubmitEvent & {
            currentTarget: HTMLFormElement;
            target: DOMElement;
        }
    ) => {
        e?.preventDefault();
        const updatedDraft = await editDraft(props.currentDraft()?.id, {
            name: draftName()
        });
        const existingDrafts = props.draftList() || [];
        props.mutateDraftList(
            existingDrafts.map((draft) =>
                draft.id === updatedDraft.id ? updatedDraft : draft
            )
        );
        props.mutateDraft(updatedDraft);
        setIsEditingName(false);
    };

    const handleOnClick = () => {
        if (isEditingName()) {
            handleNameChange();
        } else {
            setIsEditingName(true);
        }
    };

    const onFocusOut = () => {
        setIsFocused(false);
        setIsEditingName(false);
    };

    const handleKeyEvent = (key: Key) => {
        if (!isFocused()) return;
        switch (key) {
            case "Escape":
                setIsEditingName(false);
                break;
        }
    };

    const handleShare = async () => {
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            const shareLink = await generateShareLink(currentDraft.id);
            navigator.clipboard.writeText(shareLink);
            alert("Share link copied to clipboard!");
        }
    };

    const isOwner = createMemo(
        () => userAccessor()?.id === props.currentDraft()?.owner_id
    );

    return (
        <div class="mt-4 text-white">
            <KeyEvent onKeyUp={handleKeyEvent} keys={["Enter", "Escape"]} />
            <div class="flex items-center gap-2">
                <p>Name:</p>
                <div class="flex gap-2">
                    <Show
                        when={isOwner()}
                        fallback={<p>{props.currentDraft()?.name || ""}</p>}
                    >
                        <form class="flex gap-2" onSubmit={handleNameChange}>
                            {isEditingName() ? (
                                <input
                                    onFocusOut={onFocusOut}
                                    type="text"
                                    value={draftName()}
                                    onInput={(e) => setDraftName(e.currentTarget.value)}
                                    class="rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-white"
                                />
                            ) : (
                                <p>{props.currentDraft()?.name || ""}</p>
                            )}
                            {isEditingName() ? (
                                <button type="submit">
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        class="h-5 w-5"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                    >
                                        <path
                                            fill-rule="evenodd"
                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                            clip-rule="evenodd"
                                        />
                                    </svg>
                                </button>
                            ) : (
                                <button onClick={handleOnClick}>
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        class="h-5 w-5"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                    >
                                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-9.9 9.9-3.536.707.707-3.536 9.9-9.9zM12 5l-7.5 7.5-1.5 1.5.5.5 1.5-1.5L13 6l-1-1z" />
                                    </svg>
                                </button>
                            )}
                        </form>
                    </Show>
                </div>
            </div>
            <div class="flex items-center">
                <p>Public:</p>
                <label
                    class={`relative ml-2 inline-flex items-center ${isOwner() ? "cursor-pointer" : ""}`}
                >
                    <input
                        tabIndex={0}
                        type="checkbox"
                        checked={props.currentDraft()?.public}
                        class="peer sr-only"
                        onChange={handleTogglePublic}
                        disabled={!isOwner()}
                    />
                    <div class="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:border-gray-600 dark:bg-gray-700 dark:peer-focus:ring-blue-800" />
                </label>
            </div>
            <Show when={isOwner()}>
                <button
                    class="mt-4 flex-shrink-0 rounded-md bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
                    onClick={handleShare}
                >
                    Share
                </button>
            </Show>
        </div>
    );
}

export default DraftDetails;
