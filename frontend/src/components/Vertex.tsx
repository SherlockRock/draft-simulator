import { Vertex } from "../utils/schemas";

type VertexComponentProps = {
    connectionId: string;
    vertex: Vertex;
    zoom: () => number;
    onDragStart: (
        connectionId: string,
        vertexId: string,
        positionX: number,
        positionY: number,
        e: MouseEvent
    ) => void;
    isHovered: boolean;
    onHover: (hover: boolean) => void;
    isConnectionMode: boolean;
    isSelected: boolean;
    onVertexClick: (connectionId: string, vertexId: string) => void;
};

export const VertexComponent = (props: VertexComponentProps) => {
    // The connection SVG lives inside the scaled `.canvas-world` layer, so a
    // vertex draws at its raw world coordinates and every length below is a
    // screen-px constant divided by zoom to stay visually fixed.
    const VERTEX_RADIUS = 6; // Base size in screen px
    const HOVER_RADIUS = 10;
    const HITBOX_RADIUS = 16;
    const OUTLINE_WIDTH = 2;
    const colors = {
        idle: "#E03848",
        hover: "#F06830",
        selected: "#9B50C0"
    };

    // World px per screen px. zoom is clamped to MIN_ZOOM, so never zero.
    const invZoom = () => 1 / props.zoom();

    return (
        <g>
            {/* Larger invisible hitbox for easier interaction */}
            <circle
                data-connection-id={props.connectionId}
                data-vertex-id={props.vertex.id}
                cx={props.vertex.x}
                cy={props.vertex.y}
                r={HITBOX_RADIUS * invZoom()}
                fill="transparent"
                class={props.isConnectionMode ? "cursor-pointer" : "cursor-move"}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    if (props.isConnectionMode) {
                        props.onVertexClick(props.connectionId, props.vertex.id);
                    } else if (!props.isConnectionMode) {
                        props.onDragStart(
                            props.connectionId,
                            props.vertex.id,
                            props.vertex.x,
                            props.vertex.y,
                            e
                        );
                    }
                }}
                onMouseEnter={() => props.onHover(true)}
                onMouseLeave={() => props.onHover(false)}
            />

            {/* Visible vertex circle */}
            <circle
                cx={props.vertex.x}
                cy={props.vertex.y}
                r={
                    (props.isHovered || props.isSelected ? HOVER_RADIUS : VERTEX_RADIUS) *
                    invZoom()
                }
                fill={
                    props.isSelected
                        ? colors.selected
                        : props.isHovered
                          ? colors.hover
                          : colors.idle
                }
                stroke="white"
                stroke-width={OUTLINE_WIDTH * invZoom()}
                class="pointer-events-none"
            />
        </g>
    );
};
