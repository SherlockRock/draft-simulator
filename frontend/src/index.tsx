/* @refresh reload */
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";

import "./index.css";
import App from "./App";
import { UserWrapper } from "./UserWrapper";
import AuthCallback from "./AuthCallback";
import ShareDraftPage from "./ShareDraftPage";
import ShareCanvasPage from "./ShareCanvasPage";
import HomePage from "./pages/HomePage";
import DraftFlowDashboard from "./pages/DraftFlowDashboard";
import CanvasFlowDashboard from "./pages/CanvasFlowDashboard";
import VersusFlowDashboard from "./pages/VersusFlowDashboard";
import DraftDetailView from "./pages/DraftDetailView";
import CanvasDetailView from "./pages/CanvasDetailView";
import DraftWorkflow from "./workflows/DraftWorkflow";
import CanvasWorkflow from "./workflows/CanvasWorkflow";

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
                    <Route path="/" component={HomePage} />
                    <Route path="/draft" component={DraftWorkflow}>
                        <Route path="/" component={DraftFlowDashboard} />
                        <Route path="/new" component={DraftDetailView} />
                        <Route path="/:id" component={DraftDetailView} />
                    </Route>
                    <Route path="/canvas" component={CanvasWorkflow}>
                        <Route path="/" component={CanvasFlowDashboard} />
                        <Route path="/:id" component={CanvasDetailView} />
                    </Route>
                    <Route path="/versus" component={VersusFlowDashboard} />
                    <Route path="/versus/:id" component={DraftDetailView} />
                    <Route path="*" component={HomePage} />
                </Route>
            </Router>
        </QueryClientProvider>
    ),
    root!
);
