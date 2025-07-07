/* @refresh reload */
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";

import "./index.css";
import App from "./App";
import { UserWrapper } from "./UserWrapper";
import SharePage from "./SharePage";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
    throw new Error(
        "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?"
    );
}

render(
    () => (
        <Router root={App}>
            <Route path="/share" component={SharePage} />
            <Route path="/:session?" component={UserWrapper} />
            <Route path="/:token?" component={UserWrapper} />
        </Router>
    ),
    root!
);