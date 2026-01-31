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

import CanvasFlowDashboard from "./pages/CanvasFlowDashboard";
import CanvasEntryRedirect from "./components/CanvasEntryRedirect";
import VersusFlowDashboard from "./pages/VersusFlowDashboard";
import DraftDetailView from "./pages/DraftDetailView";
import CanvasDetailView from "./pages/CanvasDetailView";
import DraftWorkflow from "./workflows/DraftWorkflow";
import CanvasWorkflow from "./workflows/CanvasWorkflow";
import VersusWorkflow from "./workflows/VersusWorkflow";
import VersusSeriesOverview from "./pages/VersusSeriesOverview";
import VersusRoleSelection from "./pages/VersusRoleSelection";
import VersusDraftView from "./pages/VersusDraftView";

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
                    <Route path="/canvas" component={CanvasWorkflow}>
                        <Route path="/" component={CanvasEntryRedirect} />
                        <Route path="/dashboard" component={CanvasFlowDashboard} />
                        <Route path="/:id" component={CanvasDetailView} />
                        <Route path="/:id/draft/:draftId" component={DraftWorkflow}>
                            <Route path="/" component={DraftDetailView} />
                        </Route>
                    </Route>
                    <Route path="/versus" component={VersusWorkflow}>
                        <Route path="/" component={VersusFlowDashboard} />
                        <Route path="/join/:linkToken" component={VersusRoleSelection} />
                        <Route path="/:id" component={VersusSeriesOverview} />
                        <Route path="/:id/draft/:draftId" component={VersusDraftView} />
                    </Route>
                    <Route path="*" component={HomePage} />
                </Route>
            </Router>
        </QueryClientProvider>
    ),
    root!
);
