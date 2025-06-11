import { useUser } from "./userProvider";
import { handleLogin, handleRevoke } from "./utils/actions";

function NavBar() {
    const accessor = useUser();
    const [user, logout] = accessor();

    const handleLogOut = () => {
        handleRevoke();
        if (logout !== undefined && "logout" in logout) {
            logout.logout();
        }
    };

    return (
        <div class="flex h-12 justify-around bg-purple-950 py-1">
            {user() !== undefined && "name" in user() ? (
                <div class="flex  w-full items-center justify-around gap-2">
                    <p class="text-slate-100">Hello: {user().name}</p>
                    <button
                        class="text-md h-10 rounded bg-blue-500 px-3 font-sans font-normal hover:bg-blue-600"
                        onClick={handleLogOut}
                    >
                        Log out of Google
                    </button>
                </div>
            ) : (
                <button
                    class="text-md h-10 rounded bg-blue-500 px-3 font-sans font-normal hover:bg-blue-600"
                    onClick={handleLogin}
                >
                    Login with Google
                </button>
            )}
        </div>
    );
}

export default NavBar;
