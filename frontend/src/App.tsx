import { Component } from "solid-js";
import { RouteSectionProps } from "@solidjs/router";
import { SocketProvider } from "./socketProvider";
import NavBar from "./NavBar";

const App: Component<RouteSectionProps<unknown>> = (props) => {
    return (
        <SocketProvider>
            <div class="min-h-screen overflow-clip bg-purple-800">
                <NavBar user={{ name: "Rourke" }} />
                {props.children}
            </div>
        </SocketProvider>
    );
};

export default App;
