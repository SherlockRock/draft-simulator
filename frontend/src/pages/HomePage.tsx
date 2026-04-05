import { Component, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Title, Meta } from "@solidjs/meta";
import { LayoutDashboard, Swords } from "lucide-solid";
import FlowCard from "../components/FlowCard";
import ActivityList from "../components/ActivityList";
import { CreateCanvasDialog } from "../components/CreateCanvasDialog";
import { CreateVersusDraftDialog } from "../components/CreateVersusDraftDialog";
import { useUser } from "../userProvider";

const HomePage: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();
    const [showCreateCanvasDialog, setShowCreateCanvasDialog] = createSignal(false);
    const [showCreateVersusDialog, setShowCreateVersusDialog] = createSignal(false);

    return (
        <div class="flex-1 overflow-auto bg-darius-bg bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <Title>First Pick</Title>
            <Meta
                name="description"
                content="Plan, draft, and strategize team compositions for League of Legends. Real-time collaborative drafting, visual canvas planning, and side-by-side analysis."
            />
            <div class="mx-auto flex min-h-full max-w-7xl flex-col p-8">
                {/* Flow Navigation Cards */}
                <div class="mb-12">
                    <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
                        <FlowCard
                            title="Canvas"
                            description="Visual workspace for organizing drafts"
                            icon={
                                <LayoutDashboard
                                    size={28}
                                    class="text-darius-purple-bright"
                                />
                            }
                            onClick={() => navigate("/canvas")}
                            flowType="canvas"
                            ctaLabel="Create Canvas"
                            onCtaClick={() => setShowCreateCanvasDialog(true)}
                        />
                        <FlowCard
                            title="Versus"
                            description="Head-to-head competitive draft series"
                            icon={<Swords size={28} class="text-darius-crimson" />}
                            onClick={() => navigate("/versus")}
                            flowType="versus"
                            ctaLabel="Create Versus"
                            onCtaClick={() => setShowCreateVersusDialog(true)}
                        />
                    </div>
                </div>

                {/* Recent Activity Feed - Only show for signed-in users */}
                <Show when={user()}>
                    <section class="flex flex-1 flex-col">
                        <h2 class="mb-4 text-2xl font-semibold text-darius-text-primary">
                            Recent Activity
                        </h2>
                        <ActivityList
                            queryKeyBase={["recentActivity"]}
                            accentColor="orange"
                            emptyMessage="No recent activity"
                            keyboardControls={user()?.keyboard_controls ?? false}
                        />
                    </section>
                </Show>
            </div>

            <CreateCanvasDialog
                isOpen={showCreateCanvasDialog}
                onClose={() => setShowCreateCanvasDialog(false)}
                onSuccess={(canvasId) => {
                    setShowCreateCanvasDialog(false);
                    navigate(`/canvas/${canvasId}`);
                }}
            />
            <CreateVersusDraftDialog
                isOpen={showCreateVersusDialog}
                onClose={() => setShowCreateVersusDialog(false)}
            />
        </div>
    );
};

export default HomePage;
