import { Vertex, Viewport } from "../utils/types";
import { worldToScreen } from "../utils/helpers";

type VertexComponentProps = {
    connectionId: string;
    vertex: Vertex;
    viewport: () => Viewport;
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
    onContextMenu: (vertexId: string, e: MouseEvent) => void;
};

export const VertexComponent = (props: VertexComponentProps) => {
    const VERTEX_RADIUS = 6; // Base size in px
    const HOVER_RADIUS = 10;

    const screenPos = () => {
        const vp = props.viewport();
        return worldToScreen(props.vertex.x, props.vertex.y, vp);
    };

    return (
        <g>
            {/* Larger invisible hitbox for easier interaction */}
            <circle
                cx={screenPos().x}
                cy={screenPos().y}
                r={16}
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
                onContextMenu={(e) => {
                    if (props.onContextMenu) {
                        e.stopPropagation();
                        e.preventDefault();
                        props.onContextMenu(props.vertex.id, e);
                    }
                }}
                onMouseEnter={() => props.onHover(true)}
                onMouseLeave={() => props.onHover(false)}
            />

            {/* Visible vertex circle */}
            <circle
                cx={screenPos().x}
                cy={screenPos().y}
                r={props.isHovered || props.isSelected ? HOVER_RADIUS : VERTEX_RADIUS}
                fill={
                    props.isSelected ? "#c084fc" : props.isHovered ? "#0f766e" : "#2dd4bf"
                }
                stroke="white"
                stroke-width="2"
                class="pointer-events-none"
            />
        </g>
    );
};
