import { Component, createMemo, createSignal } from "solid-js";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import DraftInputPanel from "./DraftInputPanel";
import DecisionTree from "./DecisionTree";

const NavigatorDrafting: Component = () => {
    const { navigatorContext } = useNavigatorContext();
    const [highlightedPath, setHighlightedPath] = createSignal<number[] | null>(null);

    const treeData = createMemo(() => navigatorContext().snapshot?.tree ?? null);
    const isComputing = createMemo(
        () =>
            navigatorContext().events.length > 0 &&
            navigatorContext().snapshot === null
    );

    return (
        <div
            class="grid h-full w-full"
            style={{
                "grid-template-columns": "300px 1fr",
                "grid-template-rows": "1fr 220px"
            }}
        >
            <div class="row-span-2 overflow-y-auto border-r border-slate-700/50">
                <DraftInputPanel />
            </div>

            <div class="min-h-0 bg-slate-900/20">
                <DecisionTree
                    treeData={treeData()}
                    isComputing={isComputing()}
                    highlightedPath={highlightedPath()}
                    onNodeClick={(path) => setHighlightedPath(path)}
                />
            </div>

            <div class="flex items-center justify-center border-t border-slate-700/50 bg-slate-900/50 text-slate-500">
                Scenario lanes will render here
            </div>
        </div>
    );
};

export default NavigatorDrafting;
