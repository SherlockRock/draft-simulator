import Draft from "./Draft";
import { UserProvider } from "./userProvider";
import NavBar from "./NavBar";

export const UserWrapper = () => (
    <UserProvider>
        <NavBar />
        <Draft />
        <div class="text-center text-slate-100">v0.0.1</div>
    </UserProvider>
);
