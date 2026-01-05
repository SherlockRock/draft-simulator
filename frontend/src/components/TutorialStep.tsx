import { Component } from "solid-js";

interface TutorialStepProps {
    number: number;
    title: string;
    description: string;
}

const TutorialStep: Component<TutorialStepProps> = (props) => {
    return (
        <div class="flex gap-4 rounded-lg border border-slate-700 bg-slate-800 p-4">
            <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-teal-700 font-bold text-slate-50">
                {props.number}
            </div>
            <div class="flex-1">
                <h3 class="mb-1 text-lg font-semibold text-slate-200">{props.title}</h3>
                <p class="text-sm text-slate-400">{props.description}</p>
            </div>
        </div>
    );
};

export default TutorialStep;
