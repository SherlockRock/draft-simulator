import Draft from "./Draft";
import { UserProvider } from "./userProvider";
import NavBar from "./NavBar";
import ConnectionBanner from "./ConnectionBanner";

export const UserWrapper = () => (
    <UserProvider>
        <NavBar />
        <ConnectionBanner />
        <Draft />
        <div class="text-center text-slate-100">v0.0.1</div>
    </UserProvider>
);
