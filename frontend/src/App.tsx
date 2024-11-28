import { Component } from "solid-js";
import NavBar from "./NavBar";
import { RouteSectionProps } from "@solidjs/router";

const App: Component<RouteSectionProps<unknown>> = (props) => {
    return (
        <div class="min-h-screen overflow-clip bg-purple-800">
            <NavBar user={{ name: "Rourke" }} />
            {props.children}
        </div>
    );
};

export default App;
