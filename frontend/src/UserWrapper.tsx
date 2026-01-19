import { UserProvider } from "./userProvider";
import { RouteSectionProps } from "@solidjs/router";
import GlobalNavBar from "./components/GlobalNavBar";
import ConnectionBanner from "./ConnectionBanner";

export const UserWrapper = (props: RouteSectionProps) => {
    return (
        <UserProvider>
            <div class="flex h-screen flex-col">
                <ConnectionBanner />
                <GlobalNavBar />
                <div class="flex flex-1 overflow-hidden">{props.children}</div>
            </div>
        </UserProvider>
    );
};
