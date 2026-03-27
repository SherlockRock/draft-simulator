import { Component, For, createEffect, createSignal, on } from "solid-js";
import { Socket } from "socket.io-client";
import { useUser } from "../userProvider";
import { useVersusContext } from "../contexts/VersusContext";

interface VersusChatPanelProps {
    socket: Socket;
    versusDraftId: string;
    currentRole: "team1_captain" | "team2_captain" | "spectator" | null;
    blueSideTeam?: 1 | 2;
    isInDraftView?: boolean;
}

export const VersusChatPanel: Component<VersusChatPanelProps> = (props) => {
    const accessor = useUser();
    const [user] = accessor();
    const { chatMessages } = useVersusContext();
    const [messageInput, setMessageInput] = createSignal("");
    let messagesEndRef: HTMLDivElement | undefined;
    let containerRef: HTMLDivElement | undefined;

    const formatTime = (ts: number) => {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };

    createEffect(
        on(
            () => chatMessages(),
            () => {
                if (!containerRef) return;
                const { scrollTop, scrollHeight, clientHeight } = containerRef;
                const isNearBottom = scrollHeight - scrollTop - clientHeight < 60;
                if (isNearBottom) {
                    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
                }
            }
        )
    );

    const handleSend = (e: Event) => {
        e.preventDefault();
        const msg = messageInput().trim();
        if (msg && props.socket) {
            const currentUser = user();
            const username =
                currentUser && "name" in currentUser
                    ? (currentUser.display_name ?? currentUser.name)
                    : props.socket.id;

            props.socket.emit("sendVersusMessage", {
                versusDraftId: props.versusDraftId,
                message: msg,
                role: props.currentRole,
                username
            });

            setMessageInput("");
            messagesEndRef?.scrollIntoView({ behavior: "smooth" });
        }
    };

    const getUsernameColor = (role: string) => {
        if (props.isInDraftView) {
            const bst = props.blueSideTeam ?? 1;
            const team1IsBlue = bst === 1;
            switch (role) {
                case "team1_captain":
                    return team1IsBlue ? "text-blue-400" : "text-red-400";
                case "team2_captain":
                    return team1IsBlue ? "text-red-400" : "text-blue-400";
                default:
                    return "text-slate-400";
            }
        }
        switch (role) {
            case "team1_captain":
                return "text-violet-300";
            case "team2_captain":
                return "text-fuchsia-300";
            default:
                return "text-slate-400";
        }
    };

    return (
        <div class="flex h-full flex-col">
            <div class="flex min-h-0 flex-1 flex-col rounded-t-lg border border-orange-500/30 bg-slate-900/40">
                {/* Header */}
                <div class="flex items-center border-b border-orange-500/30 px-3 py-2.5">
                    <span class="text-[11px] font-semibold uppercase leading-none tracking-wider text-slate-200">
                        Series Chat
                    </span>
                </div>

                {/* Messages */}
                <div
                    ref={containerRef}
                    class="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-2"
                >
                    <For each={chatMessages()}>
                        {(msg) => (
                            <div class="mb-2 flex flex-wrap items-baseline text-sm">
                                <span class="shrink-0 text-[10px] text-slate-500">
                                    {formatTime(msg.timestamp)}
                                </span>
                                <span
                                    class={`pl-1 font-medium ${getUsernameColor(msg.role)}`}
                                >
                                    {msg.username}:
                                </span>
                                <span class="min-w-0 break-words pl-1 text-slate-100">
                                    {msg.message}
                                </span>
                            </div>
                        )}
                    </For>
                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form
                    class="flex items-center border-t border-orange-500/30 p-2"
                    onSubmit={handleSend}
                >
                    <input
                        type="text"
                        placeholder="Type a message..."
                        class="min-w-0 flex-1 rounded-l-md border-none bg-slate-800/60 px-3 py-1 text-sm text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-orange-500/50"
                        value={messageInput()}
                        onInput={(e) => setMessageInput(e.currentTarget.value)}
                        maxLength={500}
                    />
                    <button
                        type="submit"
                        disabled={!messageInput().trim()}
                        class="rounded-r-md bg-orange-700 px-3 py-1 text-sm font-medium text-slate-50 transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Send
                    </button>
                </form>
            </div>
        </div>
    );
};
