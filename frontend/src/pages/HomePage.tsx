import { Component, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import FlowCard from "../components/FlowCard";
import ActivityList from "../components/ActivityList";
import { useUser } from "../userProvider";

const HomePage: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();

    return (
        <div class="flex-1 overflow-auto bg-slate-900 bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto max-w-7xl p-8">
                {/* Flow Navigation Cards */}
                <div class="mb-12">
                    <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
                        <FlowCard
                            title="Canvas"
                            description="Visual workspace for organizing drafts"
                            icon="🎨"
                            onClick={() => navigate("/canvas")}
                            flowType="canvas"
                            bullets={[
                                "Create and position draft cards anywhere on the canvas",
                                "Draw connections between related drafts",
                                "Collaborate with teammates in real-time",
                                "Organize complex draft scenarios and strategies",
                                "Directly Import Versus Series and Drafts"
                            ]}
                        />
                        <FlowCard
                            title="Versus"
                            description="Head-to-head competitive draft series"
                            icon="⚔️"
                            onClick={() => navigate("/versus")}
                            flowType="versus"
                            bullets={[
                                "Create head-to-head competitive draft series (Best of 1, 3, 5, or 7)",
                                "Share a single link for others to join as Blue Captain, Red Captain, or Spectator",
                                "Choose between Fearless, Standard, or Ironman draft styles",
                                "Utilize pauses and champion swap requests to prevent headaches"
                            ]}
                        />
                    </div>
                </div>

                {/* Recent Activity Feed - Only show for signed-in users */}
                <Show when={user()}>
                    <h2 class="mb-4 text-2xl font-semibold text-slate-200">
                        Recent Activity
                    </h2>
                    <ActivityList
                        queryKeyBase={["recentActivity"]}
                        accentColor="teal"
                        emptyMessage="No recent activity"
                    />
                </Show>
            </div>
        </div>
    );
};

export default HomePage;
