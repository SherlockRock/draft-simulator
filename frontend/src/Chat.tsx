import { createSignal, For, onCleanup } from "solid-js";
import { useSocket } from "./socketProvider";
import { DOMElement } from "solid-js/jsx-runtime";

type chatMessage = {
    username: string;
    chat: string;
};

type props = {
    currentDraft: string;
};

function Chat(props: props) {
    const socket = useSocket();
    const [messages, setMessages] = createSignal<chatMessage[]>([]);
    const [message, setMessage] = createSignal("");

    socket.on("chatMessage", (newMessage: chatMessage) => {
        if (newMessage.username !== socket.id) {
            setMessages((prev) => [...prev, newMessage]);
        }
    });

    onCleanup(() => {
        socket.off("chatMessage");
    });

    const sendMessage = (
        e: SubmitEvent & {
            currentTarget: HTMLFormElement;
            target: DOMElement;
        }
    ) => {
        e.preventDefault();
        if (message().trim()) {
            const holdMessage = message();
            setMessages((prev) => [...prev, { chat: holdMessage, username: "You" }]);
            socket.emit("newMessage", { room: props.currentDraft, message: holdMessage });
            setMessage(""); // Clear the input
        }
    };

    return (
        <div class="flex flex-col items-center justify-center text-white">
            <div class="w-full bg-gray-800 p-4 shadow-lg">
                <div class="mb-4 h-64 overflow-y-auto rounded-md bg-gray-700 p-2">
                    <For each={messages()}>
                        {(msg) => (
                            <div class="mb-2 flex text-wrap ">
                                <span class="text-sm font-semibold text-blue-400">
                                    {msg.username}:
                                </span>
                                <span class="pl-1 text-sm text-slate-100">
                                    {msg.chat}
                                </span>
                            </div>
                        )}
                    </For>
                </div>
                <form class="flex items-center" onSubmit={sendMessage}>
                    <input
                        type="text"
                        placeholder="Type a message..."
                        class="flex-1 rounded-l-md border-none bg-gray-700 px-3 py-2 text-sm text-slate-100 focus:outline-none"
                        value={message()}
                        onInput={(e) => setMessage(e.target.value)}
                    />
                    <button
                        type="submit"
                        class="rounded-r-md bg-purple-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-purple-500"
                    >
                        Send
                    </button>
                </form>
            </div>
        </div>
    );
}

export default Chat;
