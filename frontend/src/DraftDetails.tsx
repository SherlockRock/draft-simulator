import { createSignal, createMemo, createEffect, Show, Resource } from "solid-js";
import { editDraft, generateShareLink } from "./utils/actions";
import KeyEvent, { Key } from "./KeyEvent";
import { DOMElement } from "solid-js/jsx-runtime";
import { useUser } from "./userProvider";
import { useQuery } from "@tanstack/solid-query";
import toast from "solid-toast";

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
    const [copied, setCopied] = createSignal(false);

    const shareLinkQuery = useQuery(() => ({
        queryKey: ["shareLink", props.currentDraft()?.id],
        queryFn: () => generateShareLink(props.currentDraft()!.id),
        enabled: isPopperOpen() && !!props.currentDraft()?.id && isOwner(),
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    createEffect(() => {
        if (shareLinkQuery.isError && isPopperOpen()) {
            toast.error("Failed to generate share link");
            setIsPopperOpen(false);
        }
    });

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

    const handleShare = () => {
        setIsPopperOpen((prev) => !prev);
    };

    const handleCopy = () => {
        if (shareLinkQuery.data) {
            navigator.clipboard.writeText(shareLinkQuery.data);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
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
        <div class="mt-4 text-slate-50">
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
                                        class="w-full rounded-md border border-slate-500 bg-slate-600 p-1 text-slate-50 focus:outline-none"
                                    />
                                </div>
                            ) : (
                                <p class="inline-block grow overflow-hidden text-ellipsis whitespace-nowrap">
                                    {props.currentDraft()?.name || ""}
                                </p>
                            )}
                            {isEditingName() ? (
                                <button
                                    type="submit"
                                    class="text-teal-700 hover:text-teal-400"
                                >
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
                                    class="text-teal-700 hover:text-teal-400"
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
                        <div class="peer h-6 w-11 rounded-full bg-slate-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-slate-50 after:transition-all hover:bg-slate-500 peer-checked:bg-teal-700 peer-checked:after:translate-x-full peer-checked:hover:bg-teal-400 " />
                    </label>
                </div>
                <Show when={isOwner()}>
                    <div class="relative inline-block" onFocusOut={handleFocusOut}>
                        <button
                            class="text-teal-700 hover:text-teal-400"
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
                            <div class="absolute -right-3/4 z-10 mb-2 w-auto min-w-max rounded-md bg-slate-600 p-2 shadow-lg">
                                <Show
                                    when={!shareLinkQuery.isPending}
                                    fallback={
                                        <div class="flex items-center gap-2 px-2 py-1">
                                            <svg
                                                class="h-5 w-5 animate-spin text-teal-400"
                                                xmlns="http://www.w3.org/2000/svg"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                            >
                                                <circle
                                                    class="opacity-25"
                                                    cx="12"
                                                    cy="12"
                                                    r="10"
                                                    stroke="currentColor"
                                                    stroke-width="4"
                                                />
                                                <path
                                                    class="opacity-75"
                                                    fill="currentColor"
                                                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                                />
                                            </svg>
                                            <span class="text-sm text-slate-300">
                                                Generating link...
                                            </span>
                                        </div>
                                    }
                                >
                                    <p class="mb-1 text-xs font-medium text-slate-300">
                                        Share Access
                                    </p>
                                    <div class="flex items-center gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={shareLinkQuery.data || ""}
                                            class="w-40 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-slate-50"
                                        />
                                        <button
                                            onClick={handleCopy}
                                            class="rounded-md bg-teal-400 p-2 text-slate-50 hover:bg-teal-700"
                                            disabled={!shareLinkQuery.data}
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
                                </Show>
                            </div>
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    );
}

export default DraftDetails;
