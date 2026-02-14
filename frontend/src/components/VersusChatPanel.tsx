import { Component, For, createSignal } from "solid-js";
import { useUser } from "../userProvider";
import { useVersusContext } from "../contexts/VersusContext";

interface VersusChatPanelProps {
    socket: any;
    versusDraftId: string;
    currentRole: "blue_captain" | "red_captain" | "spectator" | null;
}

export const VersusChatPanel: Component<VersusChatPanelProps> = (props) => {
    const accessor = useUser();
    const [user] = accessor();
    const { chatMessages } = useVersusContext();
    const [messageInput, setMessageInput] = createSignal("");
    let messagesEndRef: HTMLDivElement | undefined;

    const handleSend = (e: Event) => {
        e.preventDefault();
        const msg = messageInput().trim();
        if (msg && props.socket) {
            const username = user() && "name" in user() ? user().name : props.socket.id;

            props.socket.emit("sendVersusMessage", {
                versusDraftId: props.versusDraftId,
                message: msg,
                role: props.currentRole,
                username
            });

            setMessageInput("");
        }
    };

    const getUsernameColor = (role: string) => {
        switch (role) {
            case "blue_captain":
                return "text-blue-400";
            case "red_captain":
                return "text-red-400";
            default:
                return "text-slate-400";
        }
    };

    return (
        <div class="flex h-full flex-col">
            <div class="flex flex-1 flex-col rounded-md border border-slate-500 bg-slate-700">
                {/* Header */}
                <div class="flex justify-between border-b border-slate-500 p-2 text-sm font-medium text-slate-50">
                    <p>Series Chat</p>
                </div>

                {/* Messages */}
                <div class="flex-1 overflow-y-auto p-2">
                    <For each={chatMessages()}>
                        {(msg) => (
                            <div class="mb-2 flex flex-wrap text-sm">
                                <span
                                    class={`pl-1 font-medium ${getUsernameColor(msg.role)}`}
                                >
                                    {msg.username}:
                                </span>
                                <span class="break-all pl-1 text-slate-100">
                                    {msg.message}
                                </span>
                            </div>
                        )}
                    </For>
                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form
                    class="flex items-center border-t border-slate-500 p-2"
                    onSubmit={handleSend}
                >
                    <input
                        type="text"
                        placeholder="Type a message..."
                        class="min-w-0 flex-1 rounded-l-md border-none bg-slate-600 px-3 py-1 text-sm text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-orange-500/50"
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
