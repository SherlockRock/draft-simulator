import { Component, Show } from "solid-js";
import Draft from "../Draft";
import ConnectionBanner from "../ConnectionBanner";
import { useDraftContext } from "../workflows/DraftWorkflow";

const DraftDetailView: Component = () => {
    const { draft, mutateDraft } = useDraftContext();

    return (
        <div class="flex-1 overflow-y-auto">
            <ConnectionBanner />
            <Show
                when={draft()}
                fallback={
                    <div class="flex h-full items-center justify-center text-slate-400">
                        Draft not found
                    </div>
                }
            >
                <Draft draft={draft} mutate={mutateDraft} isLocked={draft()?.is_locked} />
            </Show>
        </div>
    );
};

export default DraftDetailView;
