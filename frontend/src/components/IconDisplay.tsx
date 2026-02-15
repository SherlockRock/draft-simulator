import { Component, Show } from "solid-js";
import { champions } from "../utils/constants";

interface IconDisplayProps {
    icon?: string | null;
    defaultIcon?: string;
    size?: "sm" | "md" | "lg";
    className?: string;
}

export const IconDisplay: Component<IconDisplayProps> = (props) => {
    const isChampionIcon = () => {
        if (!props.icon) return false;
        const num = parseInt(props.icon);
        return !isNaN(num) && num >= 0 && num < champions.length;
    };

    const getSizeClasses = () => {
        switch (props.size) {
            case "sm":
                return { container: "h-10 w-10", text: "text-2xl", img: "h-10 w-10" };
            case "lg":
                return { container: "h-16 w-16", text: "text-4xl", img: "h-16 w-16" };
            case "md":
            default:
                return { container: "h-14 w-14", text: "text-[48px]", img: "h-14 w-14" };
        }
    };

    const sizes = getSizeClasses();

    return (
        <div
            class={`flex flex-shrink-0 items-center justify-center overflow-hidden ${sizes.container} ${props.className || ""}`}
        >
            <Show
                when={props.icon}
                fallback={
                    <span class={`text-center leading-none ${sizes.text}`}>
                        {props.defaultIcon || ""}
                    </span>
                }
            >
                <Show
                    when={isChampionIcon()}
                    fallback={
                        <span class={`text-center leading-none ${sizes.text}`}>
                            {props.icon}
                        </span>
                    }
                >
                    <img
                        src={champions[parseInt(props.icon!)].img}
                        alt={champions[parseInt(props.icon!)].name}
                        class={`rounded object-cover ${sizes.img}`}
                    />
                </Show>
            </Show>
        </div>
    );
};
