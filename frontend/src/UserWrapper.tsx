import Draft from "./Draft";
import { UserProvider } from "./userProvider";
import NavBar from "./NavBar";
import ConnectionBanner from "./ConnectionBanner";
import Chat from "./Chat";
import DraftList from "./DraftList";
import { useParams } from "@solidjs/router";
import { useUser } from "./userProvider";
import { createEffect, createResource, createSignal, Show } from "solid-js";
import { fetchDefaultDraft, fetchDraftList } from "./utils/actions";
import CreateDraft from "./CreateDraft";

const Layout = () => {
    const params = useParams();
    const accessor = useUser();
    const [user, , socketAccessor] = accessor();
    const [isExpanded, setIsExpanded] = createSignal(true);
    const [childrenVisible, setChildrenVisible] = createSignal(true);
    const [draft, { mutate: mutateDraft, refetch: refetchDraft }] = createResource(
        () => (params.session !== undefined ? String(params.session) : null),
        fetchDefaultDraft
    );
    const [draftList, { mutate: mutateDraftList, refetch: refetchDraftList }] =
        createResource<any[]>(fetchDraftList);
    let navTrayRef;
    let previousUser = user();

    createEffect(() => {
        const currentUser = user();
        if (currentUser === undefined) {
            mutateDraftList([]);
        } else if (currentUser !== previousUser) {
            refetchDraftList();
            refetchDraft();
        }
        previousUser = currentUser;
    });

    const handleNavTransitionEnd = (event: TransitionEvent) => {
        if (event.target === navTrayRef) {
            if (isExpanded()) {
                setChildrenVisible(true);
            }
        }
    };

    const handleExpandMinimize = () => {
        const expanded = isExpanded();
        setIsExpanded(() => !expanded);
        if (expanded) {
            setChildrenVisible(false);
        }
    };

    const clearDraftList = () => {
        mutateDraftList([]);
        if (draft()?.public !== true) {
            mutateDraft(null);
        }
    };

    return (
        <div class="flex h-screen gap-2">
            {/* Left Sidebar */}
            <div
                class={`flex flex-col bg-gray-950 transition-all duration-300 ${isExpanded() ? "w-[max(20vw,300px)]" : "w-6"}`}
            >
                <div class="flex h-full">
                    <div
                        ref={navTrayRef}
                        class={`flex flex-1 flex-col transition-all duration-150 ${isExpanded() ? "w-full" : "w-0"}`}
                        onTransitionEnd={handleNavTransitionEnd}
                    >
                        {childrenVisible() ? (
                            <div
                                class={`flex flex-1 flex-col gap-4 px-4 ${isExpanded() ? "" : "hidden"}`}
                            >
                                <NavBar clearDraftList={clearDraftList} />
                                <DraftList
                                    currentDraft={draft}
                                    mutateDraft={mutateDraft}
                                    draftList={draftList}
                                    mutateDraftList={mutateDraftList}
                                    socket={socketAccessor}
                                />
                                <div class="flex-1">
                                    <Chat
                                        currentDraft={draft()?.id || ""}
                                        socket={socketAccessor()}
                                    />
                                </div>
                                <div class="pb-4 text-center text-slate-100">v0.0.1</div>
                            </div>
                        ) : null}
                    </div>
                    <button
                        onClick={handleExpandMinimize}
                        class="flex h-full w-6 items-center bg-purple-900 px-1 hover:bg-purple-700"
                    >
                        <svg
                            class={`h-6  transform text-white transition-transform ${isExpanded() ? "rotate-0" : "rotate-180"}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M15 19l-7-7 7-7"
                            />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div class="flex-1 overflow-y-auto">
                <ConnectionBanner />
                <Show
                    when={draft()}
                    fallback={
                        <CreateDraft draftList={draftList} mutate={mutateDraftList} />
                    }
                >
                    <Draft draft={draft} mutate={mutateDraft} />
                </Show>
            </div>
        </div>
    );
};

export const UserWrapper = () => (
    <UserProvider>
        <Layout />
    </UserProvider>
);
