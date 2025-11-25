import { UserProvider } from "./userProvider";
import { RouteSectionProps } from "@solidjs/router";

export const UserWrapper = (props: RouteSectionProps) => {
    return <UserProvider>{props.children}</UserProvider>;
};
