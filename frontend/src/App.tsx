import { Component } from "solid-js";
import { RouteSectionProps } from "@solidjs/router";
import { Toaster } from "solid-toast";

const App: Component<RouteSectionProps<unknown>> = (props) => {
    return (
        <div class="h-screen overflow-clip bg-slate-700">
            {props.children}
            <Toaster
                toastOptions={{
                    duration: 3000
                }}
            />
        </div>
    );
};

export default App;
