import { useUser } from "./userProvider";
import { handleLogin, handleRevoke } from "./utils/actions";

type props = {
    clearDraftList: () => void;
};

function NavBar(props: props) {
    const accessor = useUser();
    const [user, actions] = accessor();

    const handleLogOut = () => {
        handleRevoke();
        if (actions && "logout" in actions) {
            actions.logout();
        }
        props.clearDraftList();
    };

    return (
        <div class="flex flex-col gap-2 pt-4">
            {user() && "name" in user() ? (
                <div class="flex flex-col gap-2">
                    <p class="text-slate-100">Hello: {user().name}</p>
                    <button
                        class="text-md rounded-md bg-blue-600 px-3 py-2 font-sans font-normal hover:bg-blue-700"
                        onClick={handleLogOut}
                    >
                        Log out of Google
                    </button>
                </div>
            ) : (
                <button
                    class="text-md rounded-md bg-blue-600 px-3 py-2 font-sans font-normal hover:bg-blue-700"
                    onClick={handleLogin}
                >
                    Login with Google
                </button>
            )}
        </div>
    );
}

export default NavBar;
