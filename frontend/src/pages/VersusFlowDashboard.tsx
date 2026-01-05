import { Component } from "solid-js";

const VersusFlowDashboard: Component = () => {
    return (
        <div class="flex-1 overflow-auto bg-slate-900">
            <div class="mx-auto flex min-h-full max-w-4xl flex-col items-center justify-center p-8">
                <div class="text-center">
                    <div class="mb-6 text-6xl">⚔️</div>
                    <h1 class="mb-4 text-5xl font-bold text-slate-50">Versus Mode</h1>
                    <p class="mb-8 text-2xl text-teal-400">Coming Soon</p>

                    <section class="rounded-lg border border-slate-700 bg-slate-800 p-6 text-left">
                        <h2 class="mb-4 text-xl font-semibold text-slate-200">
                            What to Expect
                        </h2>
                        <p class="mb-4 text-slate-300">
                            Versus mode will allow you to simulate head-to-head draft
                            battles, compare team compositions, and analyze matchups.
                        </p>
                        <ul class="list-inside list-disc space-y-2 text-slate-300">
                            <li>Create head-to-head draft scenarios</li>
                            <li>Compare team compositions side by side</li>
                            <li>Analyze matchup strengths and weaknesses</li>
                            <li>Share versus drafts for strategy discussion</li>
                        </ul>
                    </section>
                </div>
            </div>
        </div>
    );
};

export default VersusFlowDashboard;
