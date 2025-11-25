/* @refresh reload */
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";

import "./index.css";
import App from "./App";
import { UserWrapper } from "./UserWrapper";
import DraftWorkflow from "./workflows/DraftWorkflow";
import CanvasWorkflow from "./workflows/CanvasWorkflow";
import AuthCallback from "./AuthCallback";
import ShareDraftPage from "./ShareDraftPage";
import ShareCanvasPage from "./ShareCanvasPage";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
    throw new Error(
        "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?"
    );
}

const queryClient = new QueryClient();

render(
    () => (
        <QueryClientProvider client={queryClient}>
            <Router root={App}>
                <Route path="/share/draft" component={ShareDraftPage} />
                <Route path="/share/canvas" component={ShareCanvasPage} />
                <Route path="/" component={UserWrapper}>
                    <Route path="/oauth2callback" component={AuthCallback} />
                    <Route path="/" component={DraftWorkflow} />
                    <Route path="/draft/:id" component={DraftWorkflow} />
                    <Route path="/canvas/:id" component={CanvasWorkflow} />
                </Route>
            </Router>
        </QueryClientProvider>
    ),
    root!
);
