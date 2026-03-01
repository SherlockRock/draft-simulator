import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
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
        <div class="flex-1 overflow-auto bg-slate-900 bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto min-h-full max-w-7xl flex flex-col justify-center p-8">
                {/* Inline banner */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex items-center overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800">
                        {/* Subtle gradient overlay */}
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-purple-500/5 to-transparent" />

                        {/* Side accent stripe */}
                        <div class="absolute inset-y-0 left-0 w-2 bg-purple-500" />

                        {/* Title + tagline */}
                        <div class="relative flex flex-1 items-center gap-3 py-6 pl-8 pr-4">
                            <span class="text-4xl">🎨</span>
                            <div>
                                <h1 class="text-2xl font-bold text-slate-50">
                                    Canvas Mode
                                </h1>
                                <p class="text-sm text-slate-300">
                                    Visually organize and connect your drafts
                                </p>
                            </div>
                        </div>

                        {/* CTA button */}
                        <div class="relative pr-8">
                            <button
                                onClick={handleCreateCanvas}
                                class="rounded-lg bg-purple-500 px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 hover:shadow-purple-500/35"
                            >
                                Create New Canvas
                            </button>
                        </div>
                    </div>
                </div>

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
