import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Title, Meta } from "@solidjs/meta";
import { LayoutDashboard } from "lucide-solid";
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
        <div class="flex-1 overflow-auto bg-darius-bg bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <Title>Canvas Dashboard - First Pick</Title>
            <Meta
                name="description"
                content="Visual workspace for organizing and planning drafts."
            />
            <div class="mx-auto flex min-h-full max-w-7xl flex-col p-8">
                {/* Inline banner */}
                <div class="mx-auto mb-12 max-w-3xl">
                    <div class="relative flex items-center overflow-hidden rounded-xl border border-darius-border/50 bg-darius-card">
                        {/* Subtle gradient overlay */}
                        <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-darius-purple/[0.08] to-transparent" />

                        {/* Title + tagline */}
                        <div class="relative flex flex-1 items-center gap-3 py-6 pl-8 pr-4">
                            <LayoutDashboard
                                size={28}
                                class="text-darius-purple-bright"
                            />
                            <div>
                                <h1 class="text-2xl font-bold text-darius-text-primary">
                                    Canvas Mode
                                </h1>
                                <p class="text-sm text-darius-text-secondary">
                                    Visually organize and connect your drafts
                                </p>
                            </div>
                        </div>

                        {/* CTA button */}
                        <div class="relative pr-8">
                            <button
                                onClick={handleCreateCanvas}
                                class="rounded-lg bg-darius-purple px-5 py-2.5 text-sm font-semibold text-darius-text-primary shadow-[0_4px_12px_rgba(122,56,128,0.15)] transition-all hover:shadow-[0_6px_16px_rgba(122,56,128,0.22)] hover:brightness-125"
                            >
                                Create New Canvas
                            </button>
                        </div>
                    </div>
                </div>

                {/* Recent Canvas Activity - full width of container */}
                <Show when={user()}>
                    <section class="flex flex-1 flex-col">
                        <h2 class="mb-5 text-xl font-semibold text-darius-text-primary">
                            Recent Canvas Activity
                        </h2>
                        <ActivityList
                            queryKeyBase={["recentActivity", "canvas"]}
                            resourceType="canvas"
                            accentColor="purple"
                            emptyMessage="No recent canvas activity"
                            keyboardControls={user()?.keyboard_controls ?? false}
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
