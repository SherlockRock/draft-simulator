import type { Component } from "solid-js";
import NavBar from "./NavBar";
import Draft from "./Draft";

const App: Component = () => {
    return (
        <div class="min-h-screen overflow-clip bg-purple-800">
            <NavBar user={{ name: "Rourke" }} />
            <Draft />
        </div>
    );
};

export default App;
