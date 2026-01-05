import { UserProvider } from "./userProvider";
import { RouteSectionProps } from "@solidjs/router";
import GlobalNavBar from "./components/GlobalNavBar";

export const UserWrapper = (props: RouteSectionProps) => {
    return (
        <UserProvider>
            <div class="flex h-screen flex-col">
                <GlobalNavBar />
                <div class="flex flex-1 overflow-hidden">{props.children}</div>
            </div>
        </UserProvider>
    );
};
