import { Component } from "solid-js";

/**
 * The corner resize affordance, shared by custom Groups and annotations.
 *
 * Extracted so the two genuinely MIRROR rather than carrying two copies of the
 * same three-stroke chevron that can drift apart. The Group shipped this icon;
 * the annotation shipped a hit target with no icon at all, which is most of why
 * the Group's felt findable and the note's did not — there was nothing to aim
 * at, only a cursor change once you were already on it.
 *
 * `size` is in WORLD px and comes from `resizeHandleWorldPx`, so the caller
 * owns the zoom rule and this owns the appearance. The icon is sized in
 * PERCENTAGES of that box, so it tracks the box at any zoom without a second
 * copy of the same arithmetic.
 */
export type ResizeGripCorner = "se" | "sw";

type ResizeGripProps = {
    corner: ResizeGripCorner;
    /** Side length of the square hit target, in world px. */
    size: number;
    onMouseDown: (e: MouseEvent) => void;
};

/**
 * The chevron, drawn into a 10x10 viewBox. Two nested strokes reading as a
 * corner, pointing at the corner they resize.
 */
const CORNER_PATH: Record<ResizeGripCorner, string> = {
    se: "M9 1L1 9M9 5L5 9",
    sw: "M1 1L9 9M1 5L5 9"
};

export const ResizeGrip: Component<ResizeGripProps> = (props) => (
    <div
        class="absolute bottom-0"
        classList={{
            "right-0 cursor-se-resize": props.corner === "se",
            "left-0 cursor-sw-resize": props.corner === "sw"
        }}
        style={{ width: `${props.size}px`, height: `${props.size}px` }}
        onMouseDown={(e) => props.onMouseDown(e)}
    >
        <svg
            class="absolute text-darius-text-secondary"
            classList={{
                "right-[25%]": props.corner === "se",
                "left-[25%]": props.corner === "sw"
            }}
            style={{ bottom: "25%", width: "75%", height: "75%" }}
            fill="currentColor"
            viewBox="0 0 10 10"
        >
            <path
                d={CORNER_PATH[props.corner]}
                stroke="currentColor"
                stroke-width="1.5"
                fill="none"
            />
        </svg>
    </div>
);

export default ResizeGrip;
