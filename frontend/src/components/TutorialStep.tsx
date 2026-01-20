import { Component } from "solid-js";

interface TutorialStepProps {
    number: number;
    title: string;
    description: string;
    color?: "teal" | "orange" | "blue" | "purple";
}

const colorClasses = {
    teal: "bg-teal-700",
    orange: "bg-gradient-to-br from-orange-500 to-orange-600",
    blue: "bg-gradient-to-br from-blue-500 to-blue-600",
    purple: "bg-gradient-to-br from-purple-500 to-purple-600"
};

const TutorialStep: Component<TutorialStepProps> = (props) => {
    const bgClass = () => colorClasses[props.color || "teal"];

    return (
        <div class="flex gap-4 rounded-lg border border-slate-700 bg-slate-800 p-4">
            <div
                class={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full font-bold text-white ${bgClass()}`}
            >
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
