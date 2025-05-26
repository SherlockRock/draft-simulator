import Draft from "./Draft";
import { UserProvider } from "./userProvider";
import NavBar from "./NavBar";

export const UserWrapper = () => (
    <UserProvider>
        <NavBar />
        <Draft />
    </UserProvider>
);
