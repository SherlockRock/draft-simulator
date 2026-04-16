import { Component } from "solid-js";
import DraftInputPanel from "./DraftInputPanel";

const NavigatorDrafting: Component = () => {
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

            <div class="flex items-center justify-center bg-slate-900/50 text-slate-500">
                Decision tree will render here
            </div>

            <div class="flex items-center justify-center border-t border-slate-700/50 bg-slate-900/50 text-slate-500">
                Scenario lanes will render here
            </div>
        </div>
    );
};

export default NavigatorDrafting;
