import { createSignal, JSX } from "solid-js";
import { useUser } from "./userProvider";
import { handleLogin, handleRevoke } from "./utils/actions";

type props = {
    children: JSX.Element;
    handleLogOut?: () => void;
};

function NavBar(props: props) {
    const accessor = useUser();
    const [user, actions] = accessor();
    const [isExpanded, setIsExpanded] = createSignal(true);
    const [childrenVisible, setChildrenVisible] = createSignal(true);
    let navTrayRef: HTMLDivElement | undefined;

    const handleLogOut = () => {
        handleRevoke();
        if (actions && "logout" in actions && props.handleLogOut !== undefined) {
            actions.logout();
            props.handleLogOut();
        }
    };

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

    return (
        <div
            class={`flex flex-col bg-slate-800 transition-all duration-300 ${isExpanded() ? "w-[max(20vw,300px)]" : "w-6"}`}
        >
            <div class="flex h-full">
                <div
                    ref={navTrayRef}
                    class={`flex flex-1 flex-col overflow-hidden transition-all duration-150 ${isExpanded() ? "w-full" : "w-0"}`}
                    onTransitionEnd={handleNavTransitionEnd}
                >
                    {childrenVisible() ? (
                        <div
                            class={`flex h-full flex-1 flex-col gap-4 px-4 ${isExpanded() ? "" : "hidden"}`}
                        >
                            <div class="flex flex-col gap-2 pt-4">
                                {user() && "name" in user() ? (
                                    <div class="flex flex-col gap-2">
                                        <p class="text-slate-50">Hello: {user().name}</p>
                                        <button
                                            class="text-md rounded-md bg-teal-700 px-3 py-2 font-sans font-normal text-slate-100 hover:bg-teal-400"
                                            onClick={handleLogOut}
                                        >
                                            Log out of Google
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        class="text-md rounded-md bg-teal-700 px-3 py-2 font-sans font-normal text-slate-100 hover:bg-teal-400"
                                        onClick={handleLogin}
                                    >
                                        Login with Google
                                    </button>
                                )}
                            </div>
                            {props.children}
                        </div>
                    ) : null}
                </div>
                <button
                    onClick={handleExpandMinimize}
                    class="flex h-full w-6 items-center bg-teal-700 px-1 hover:bg-teal-400"
                >
                    <svg
                        class={`h-6 transform text-white transition-transform ${isExpanded() ? "rotate-0" : "rotate-180"}`}
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
    );
}

export default NavBar;
