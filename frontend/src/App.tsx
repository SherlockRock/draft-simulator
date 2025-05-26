import { Component } from "solid-js";
import { RouteSectionProps } from "@solidjs/router";

const App: Component<RouteSectionProps<unknown>> = (props) => {
    return <div class="min-h-screen overflow-clip bg-purple-800">{props.children}</div>;
};

export default App;
