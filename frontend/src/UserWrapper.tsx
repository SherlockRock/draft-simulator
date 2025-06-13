import Draft from "./Draft";
import { UserProvider } from "./userProvider";
import NavBar from "./NavBar";
import ConnectionBanner from "./ConnectionBanner";
import Chat from "./Chat";
import DraftList from "./DraftList";
import { useParams } from "@solidjs/router";
import { useUser } from "./userProvider";
import { createResource } from "solid-js";
import { fetchDraft } from "./utils/actions";

const handleFetch = async (id: string) => {
    const draft = await fetchDraft(id);
    if (draft === null) {
        return { picks: [...Array(20)].map(() => ""), id: "" };
    } else if ("id" in draft) {
        return draft;
    }
    return draft[0];
};

const Layout = () => {
    const params = useParams();
    const accessor = useUser();
    const socketAccessor = accessor()[2];
    const [draft, { mutate }] = createResource(
        () => (params.session !== undefined ? String(params.session) : ""),
        handleFetch
    );

    return (
        <div class="flex h-screen">
            {/* Left Sidebar */}
            <div class="flex w-[max(20vw,300px)] flex-col bg-purple-950">
                <NavBar />
                <div class="flex flex-1 flex-col overflow-y-auto p-4">
                    <DraftList currentDraft={params.session} socket={socketAccessor()} />
                    <div class="mt-4 flex-1">
                        <Chat
                            currentDraft={draft()?.id || ""}
                            socket={socketAccessor()}
                        />
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div class="flex-1 overflow-y-auto">
                <ConnectionBanner />
                <Draft draft={draft} mutate={mutate} />
                <div class="text-center text-slate-100">v0.0.1</div>
            </div>
        </div>
    );
};

export const UserWrapper = () => (
    <UserProvider>
        <Layout />
    </UserProvider>
);
