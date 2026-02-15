import { AnchorType } from "../utils/schemas";
import { cardHeight, cardWidth } from "../utils/helpers";
import { createMemo } from "solid-js";

type AnchorPointProps = {
    onSelectAnchor: (anchorType: AnchorType) => void;
    layoutToggle: () => boolean;
    zoom: number;
    selected: () => boolean;
    sourceAnchor: () => { type: AnchorType } | null;
};

export const AnchorPoints = (props: AnchorPointProps) => {
    const currentWidth = createMemo(() => cardWidth(props.layoutToggle()));
    const currentHeight = createMemo(() => cardHeight(props.layoutToggle()));

    const anchorSize = () => Math.max(6, 8 / props.zoom);

    return (
        <div class="pointer-events-none absolute inset-0">
            {/* Top anchor */}
            <div
                class={`pointer-events-auto absolute -translate-x-1/2 cursor-pointer rounded-full ${props.selected() && props.sourceAnchor()?.type === "top" ? "bg-purple-400 hover:bg-purple-600" : "bg-yellow-400 hover:bg-yellow-500"}`}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${currentWidth() / 2}px`,
                    top: "-6px"
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor("top");
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.width = `${anchorSize()}px`;
                    e.currentTarget.style.height = `${anchorSize()}px`;
                }}
            />

            {/* Bottom anchor */}
            <div
                class={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full ${props.selected() && props.sourceAnchor()?.type === "bottom" ? "bg-purple-400 hover:bg-purple-600" : "bg-yellow-400 hover:bg-yellow-500"}`}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${currentWidth() / 2}px`,
                    top: `${currentHeight() + 2}px`
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor("bottom");
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.width = `${anchorSize()}px`;
                    e.currentTarget.style.height = `${anchorSize()}px`;
                }}
            />

            {/* Left anchor */}
            <div
                class={`pointer-events-auto absolute -translate-x-1/2 cursor-pointer rounded-full ${props.selected() && props.sourceAnchor()?.type === "left" ? "bg-purple-400 hover:bg-purple-600" : "bg-yellow-400 hover:bg-yellow-500"}`}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: "-2px",
                    top: `${currentHeight() / 2}px`
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor("left");
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.width = `${anchorSize()}px`;
                    e.currentTarget.style.height = `${anchorSize()}px`;
                }}
            />

            {/* Right anchor */}
            <div
                class={`pointer-events-auto absolute -translate-x-1/2 cursor-pointer rounded-full ${props.selected() && props.sourceAnchor()?.type === "right" ? "bg-purple-400 hover:bg-purple-600" : "bg-yellow-400 hover:bg-yellow-500"}`}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${currentWidth() + 2}px`,
                    top: `${currentHeight() / 2}px`
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor("right");
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.width = `${anchorSize()}px`;
                    e.currentTarget.style.height = `${anchorSize()}px`;
                }}
            />
        </div>
    );
};
