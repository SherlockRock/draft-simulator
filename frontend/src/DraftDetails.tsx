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
    const [isPopperOpen, setIsPopperOpen] = createSignal(false);
    const [shareLink, setShareLink] = createSignal("");
    const [copied, setCopied] = createSignal(false);

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
        if (isPopperOpen()) {
            setIsPopperOpen(false);
            return;
        }
        const currentDraft = props.currentDraft();
        if (currentDraft) {
            const link = await generateShareLink(currentDraft.id);
            setShareLink(link);
            setIsPopperOpen(true);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(shareLink());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleFocusOut = (e: FocusEvent) => {
        const container = e.currentTarget as HTMLDivElement;
        if (e.relatedTarget === null || !container.contains(e.relatedTarget as Node)) {
            setIsPopperOpen(false);
        }
    };

    const isOwner = createMemo(
        () => userAccessor()?.id === props.currentDraft()?.owner_id
    );

    return (
        <div class="mt-4 text-white">
            <KeyEvent onKeyUp={handleKeyEvent} keys={["Enter", "Escape"]} />
            <div class="flex h-9 items-center">
                <div class="flex w-full gap-2">
                    <Show
                        when={isOwner()}
                        fallback={<p>{props.currentDraft()?.name || ""}</p>}
                    >
                        <form
                            class="flex h-9 w-full items-center justify-between gap-2"
                            onSubmit={handleNameChange}
                        >
                            <p>Name:</p>
                            {isEditingName() ? (
                                <div class="grow">
                                    <input
                                        onFocusOut={onFocusOut}
                                        type="text"
                                        value={draftName()}
                                        onInput={(e) =>
                                            setDraftName(e.currentTarget.value)
                                        }
                                        class="w-full rounded-md border border-gray-700 bg-gray-800 p-1 text-white"
                                    />
                                </div>
                            ) : (
                                <p class="inline-block grow overflow-hidden text-ellipsis whitespace-nowrap">
                                    {props.currentDraft()?.name || ""}
                                </p>
                            )}
                            {isEditingName() ? (
                                <button type="submit" class="hover:text-blue-600">
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
                                <button
                                    onClick={handleOnClick}
                                    class="hover:text-blue-600"
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        class="h-5 w-5"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        stroke-width="2"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.586a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                        />
                                    </svg>
                                </button>
                            )}
                        </form>
                    </Show>
                </div>
            </div>
            <div class="flex items-center justify-between">
                <div class="flex">
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
                        <div class="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all peer-checked:bg-blue-600 peer-checked:after:translate-x-full " />
                    </label>
                </div>
                <Show when={isOwner()}>
                    <div class="relative inline-block" onFocusOut={handleFocusOut}>
                        <button
                            class="text-white hover:text-blue-600"
                            onClick={handleShare}
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                class="h-5 w-5"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                            >
                                <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                            </svg>
                        </button>
                        <Show when={isPopperOpen()}>
                            <div class="absolute -right-3/4 z-10 mb-2 w-auto min-w-max rounded-md bg-gray-800 p-2 shadow-lg">
                                <div class="flex items-center gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={shareLink()}
                                        class="w-48 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-white"
                                    />
                                    <button
                                        onClick={handleCopy}
                                        class="rounded-md bg-blue-600 p-2 text-white hover:bg-blue-700"
                                    >
                                        <Show
                                            when={!copied()}
                                            fallback={
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
                                            }
                                        >
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-5 w-5"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                                />
                                            </svg>
                                        </Show>
                                    </button>
                                </div>
                            </div>
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    );
}

export default DraftDetails;
