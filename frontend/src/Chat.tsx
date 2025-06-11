import { createEffect, createSignal, For, onCleanup } from "solid-js";
import { DOMElement } from "solid-js/jsx-runtime";
import { useUser } from "./userProvider";

type chatMessage = {
    username: string;
    chat: string;
};

type props = {
    currentDraft: string;
    socket: any;
};

function Chat(props: props) {
    const accessor = useUser();
    const userAccessor = accessor()[0];
    const [messages, setMessages] = createSignal<chatMessage[]>([]);
    const [message, setMessage] = createSignal("");
    const [previousDraft, setPreviousDraft] = createSignal("");

    createEffect(() => {
        if (previousDraft() === "") {
            setPreviousDraft(props.currentDraft);
        } else if (previousDraft() !== props.currentDraft) {
            setMessages([]); // Clear messages when the draft changes
            setPreviousDraft(props.currentDraft);
        }
    });

    createEffect(() => {
        props.socket.on(
            "chatMessage",
            (newMessage: { username: string; chat: string; socketId: string }) => {
                console.log("Received message:", newMessage);
                if (newMessage.socketId !== props.socket.id) {
                    setMessages((prev) => [...prev, newMessage]);
                }
            }
        );

        onCleanup(() => {
            props.socket.off("chatMessage");
        });
    });

    const sendMessage = (
        e: SubmitEvent & {
            currentTarget: HTMLFormElement;
            target: DOMElement;
        }
    ) => {
        e.preventDefault();
        if (message().trim()) {
            const user = userAccessor();
            let username = "";
            if (user !== undefined && "name" in user) {
                username = user.name;
            } else {
                username = props.socket.id;
            }
            console.log(user);
            console.log("Sending message:", message(), "from user:", username);
            const holdMessage = message();
            setMessages((prev) => [...prev, { chat: holdMessage, username }]);
            props.socket.emit("newMessage", {
                room: props.currentDraft,
                message: holdMessage
            });
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
