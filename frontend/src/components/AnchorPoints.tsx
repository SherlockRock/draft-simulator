import { AnchorType } from "../utils/schemas";

type AnchorPointProps = {
    onSelectAnchor: (anchorType: AnchorType) => void;
    width: () => number;
    height: () => number;
    zoom: number;
    selected: () => boolean;
    sourceAnchor: () => { type: AnchorType } | null;
};

export const AnchorPoints = (props: AnchorPointProps) => {
    const anchorSize = () => Math.max(6, 8 / props.zoom);
    const anchorClass = (type: AnchorType) =>
        `pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border border-darius-border/70 shadow-[0_0_0_1px_rgba(26,16,24,0.55)] transition-colors ${
            props.selected() && props.sourceAnchor()?.type === type
                ? "bg-darius-purple-bright"
                : "bg-darius-ember hover:bg-darius-crimson"
        }`;

    return (
        <div class="pointer-events-none absolute inset-0">
            {/* Top anchor */}
            <div
                class={anchorClass("top")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${props.width() / 2}px`,
                    top: "0px"
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
                class={anchorClass("bottom")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${props.width() / 2}px`,
                    top: `${props.height()}px`
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
                class={anchorClass("left")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: "0px",
                    top: `${props.height() / 2}px`
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
                class={anchorClass("right")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${props.width()}px`,
                    top: `${props.height() / 2}px`
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
