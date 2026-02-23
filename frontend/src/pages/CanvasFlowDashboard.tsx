import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import TutorialStep from "../components/TutorialStep";
import ActivityList from "../components/ActivityList";
import { useUser } from "../userProvider";
import { CreateCanvasDialog } from "../components/CreateCanvasDialog";

const CanvasFlowDashboard: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();
    const [showCreateDialog, setShowCreateDialog] = createSignal(false);

    const handleCreateCanvas = () => {
        setShowCreateDialog(true);
    };

    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto max-w-7xl p-8">
                {/* Hero intro section - centered panel within wider container */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800">
                        {/* Subtle gradient overlay */}
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-purple-500/5 to-transparent" />

                        {/* Side accent stripe */}
                        <div class="w-2 flex-shrink-0 bg-purple-500" />

                        <div class="relative p-8">
                            <div class="mb-6 flex items-center gap-3">
                                <span class="text-4xl">🎨</span>
                                <h1 class="text-3xl font-bold text-slate-50">
                                    Canvas Mode
                                </h1>
                            </div>

                            <p class="mb-4 text-slate-300">
                                Canvas is an infinite workspace for visually organizing
                                and connecting your drafts.
                            </p>

                            <ul class="mb-8 space-y-2 text-slate-300">
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" />
                                    Create and position draft cards anywhere on the canvas
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" />
                                    Draw connections between related drafts
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" />
                                    Collaborate with teammates in real-time
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" />
                                    Organize complex draft scenarios and strategies
                                </li>
                            </ul>

                            <button
                                onClick={handleCreateCanvas}
                                class="rounded-lg bg-gradient-to-r from-purple-600 to-purple-500 px-6 py-3 font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:from-purple-500 hover:to-purple-400 hover:shadow-purple-500/30"
                            >
                                Create New Canvas
                            </button>
                        </div>
                    </div>
                </div>

                {/* How it works - spans wider */}
                <section class="mb-12">
                    <h2 class="mb-5 text-xl font-semibold text-slate-200">
                        How It Works
                    </h2>
                    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <TutorialStep
                            number={1}
                            title="Create a Canvas"
                            description="Use the canvas selector in the left panel to create your first canvas"
                            color="purple"
                        />
                        <TutorialStep
                            number={2}
                            title="Add Drafts"
                            description="Double-click the canvas to create draft cards, or add existing standalone drafts"
                            color="purple"
                        />
                        <TutorialStep
                            number={3}
                            title="Make Connections"
                            description="Enter connection mode to draw relationships between drafts"
                            color="purple"
                        />
                    </div>
                </section>

                {/* Recent Canvas Activity - full width of container */}
                <Show when={user()}>
                    <section>
                        <h2 class="mb-5 text-xl font-semibold text-slate-200">
                            Recent Canvas Activity
                        </h2>
                        <ActivityList
                            queryKeyBase={["recentActivity", "canvas"]}
                            resourceType="canvas"
                            accentColor="purple"
                            emptyMessage="No recent canvas activity"
                        />
                    </section>
                </Show>
            </div>

            <CreateCanvasDialog
                isOpen={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
                onSuccess={(canvasId) => {
                    setShowCreateDialog(false);
                    navigate(`/canvas/${canvasId}`);
                }}
            />
        </div>
    );
};

export default CanvasFlowDashboard;
