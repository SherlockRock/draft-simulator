/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import { MetaProvider } from "@solidjs/meta";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";

import "./index.css";
import App from "./App";
import { UserWrapper } from "./UserWrapper";
import AuthCallback from "./AuthCallback";
import CanvasEntryRedirect from "./components/CanvasEntryRedirect";
import DraftWorkflow from "./workflows/DraftWorkflow";
import CanvasWorkflow from "./workflows/CanvasWorkflow";
import VersusWorkflow from "./workflows/VersusWorkflow";
import { initAnalytics } from "./utils/analytics";

// Lazy-loaded page components for code splitting
const ShareCanvasPage = lazy(() => import("./ShareCanvasPage"));
const HomePage = lazy(() => import("./pages/HomePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const CanvasFlowDashboard = lazy(() => import("./pages/CanvasFlowDashboard"));
const VersusFlowDashboard = lazy(() => import("./pages/VersusFlowDashboard"));
const DraftDetailView = lazy(() => import("./pages/DraftDetailView"));
const CanvasDetailView = lazy(() => import("./pages/CanvasDetailView"));
const VersusSeriesOverview = lazy(() => import("./pages/VersusSeriesOverview"));
const VersusRoleSelection = lazy(() => import("./pages/VersusRoleSelection"));
const VersusDraftView = lazy(() => import("./pages/VersusDraftView"));

initAnalytics();

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
    throw new Error(
        "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?"
    );
}

const queryClient = new QueryClient();

render(
    () => (
        <MetaProvider>
            <QueryClientProvider client={queryClient}>
                <Router root={App}>
                    <Route path="/share/canvas" component={ShareCanvasPage} />
                    <Route path="/" component={UserWrapper}>
                        <Route path="/oauth2callback" component={AuthCallback} />
                        <Route path="/settings" component={SettingsPage} />
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
                            <Route
                                path="/join/:linkToken"
                                component={VersusRoleSelection}
                            />
                            <Route path="/:id" component={VersusSeriesOverview} />
                            <Route
                                path="/:id/draft/:draftId"
                                component={VersusDraftView}
                            />
                        </Route>
                        <Route path="*" component={HomePage} />
                    </Route>
                </Router>
            </QueryClientProvider>
        </MetaProvider>
    ),
    root!
);
