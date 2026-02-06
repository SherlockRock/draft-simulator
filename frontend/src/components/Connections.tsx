import { createSignal, Show, createMemo, For } from "solid-js";
import { Portal } from "solid-js/web";
import {
    CanvasDraft,
    CanvasGroup,
    Connection,
    Viewport,
    ContextMenuPosition,
    AnchorType
} from "../utils/types";
import {
    getAnchorScreenPosition,
    getGroupAnchorScreenPosition,
    worldToScreen,
    screenToWorld,
    cardWidth,
    cardHeight
} from "../utils/helpers";
import { ContextMenu } from "./ContextMenu";
import { VertexComponent } from "./Vertex";

export const ConnectionComponent = (props: {
    connection: Connection;
    drafts: CanvasDraft[];
    groups: CanvasGroup[];
    viewport: () => Viewport;
    onDeleteConnection: (id: string) => void;
    onCreateVertex: (connectionId: string, x: number, y: number) => void;
    onDeleteVertex: (connectionId: string, vertexId: string) => void;
    onVertexDragStart: (
        connectionId: string,
        vertexId: string,
        positionX: number,
        positionY: number,
        e: MouseEvent
    ) => void;
    isConnectionMode: boolean;
    onConnectionClick?: (connectionId: string) => void;
    onVertexClick: (connectionId: string, vertexId: string) => void;
    selectedVertexId?: string | null;
    layoutToggle: () => boolean;
}) => {
    const [isHovered, setIsHovered] = createSignal(false);
    const [contextMenu, setContextMenu] = createSignal<{
        position: ContextMenuPosition;
        type: "connection" | "vertex";
        vertexId?: string;
    } | null>(null);
    const [hoveredVertex, setHoveredVertex] = createSignal<string | null>(null);

    let svgElementRef: SVGSVGElement | null = null;

    const findDraft = (draftId: string) => {
        return props.drafts.find((d) => d.Draft.id === draftId);
    };

    const findGroupForDraft = (draft: CanvasDraft): CanvasGroup | null => {
        if (!draft.group_id) return null;
        return props.groups.find((g) => g.id === draft.group_id) ?? null;
    };

    const resolveEndpointPosition = (endpoint: Connection["source_draft_ids"][0]) => {
        if (endpoint.type === "group") {
            const group = props.groups.find((g) => g.id === endpoint.group_id);
            if (!group) return null;
            return getGroupAnchorScreenPosition(
                group,
                endpoint.anchor_type,
                props.viewport()
            );
        }
        const draft = findDraft(endpoint.draft_id);
        if (!draft) return null;
        return getAnchorScreenPosition(
            draft,
            endpoint.anchor_type,
            props.layoutToggle(),
            props.viewport(),
            findGroupForDraft(draft)
        );
    };

    const sourcePositions = createMemo(() => {
        if (!props.connection) return [];
        return props.connection.source_draft_ids
            .map(resolveEndpointPosition)
            .filter(Boolean);
    });

    const targetPositions = createMemo(() => {
        if (!props.connection) return [];
        return props.connection.target_draft_ids
            .map(resolveEndpointPosition)
            .filter(Boolean);
    });

    // Calculate vertex positions in screen coords
    const vertexPositions = createMemo(() => {
        if (!props.connection) return [];
        return props.connection.vertices.map((v) => {
            const vp = props.viewport();
            return worldToScreen(v.x, v.y, vp);
        });
    });

    // Build SVG path segments
    const pathSegments = createMemo(() => {
        const sources = sourcePositions();
        const targets = targetPositions();
        const vertices = vertexPositions();

        if (sources.length === 0 || targets.length === 0) return [];

        const segments: Array<{
            from: { x: number; y: number };
            to: { x: number; y: number };
        }> = [];

        if (vertices.length === 0) {
            // Direct connections from each source to each target
            sources.forEach((src) => {
                targets.forEach((tgt) => {
                    if (src && tgt) {
                        segments.push({ from: src, to: tgt });
                    }
                });
            });
        } else {
            // Connect sources to first vertex
            sources.forEach((src) => {
                if (src) {
                    segments.push({ from: src, to: vertices[0] });
                }
            });

            // Connect vertices in sequence
            for (let i = 0; i < vertices.length - 1; i++) {
                segments.push({ from: vertices[i], to: vertices[i + 1] });
            }

            // Connect last vertex to targets
            const lastVertex = vertices[vertices.length - 1];
            targets.forEach((tgt) => {
                if (tgt) {
                    segments.push({ from: lastVertex, to: tgt });
                }
            });
        }

        return segments;
    });

    // Build single SVG path string from all segments
    const path = createMemo(() => {
        const segments = pathSegments();
        if (segments.length === 0) return "";

        const pathCommands = segments.map((seg, idx) => {
            if (idx === 0) {
                return `M ${seg.from.x} ${seg.from.y} L ${seg.to.x} ${seg.to.y}`;
            }
            return `M ${seg.from.x} ${seg.from.y} L ${seg.to.x} ${seg.to.y}`;
        });

        return pathCommands.join(" ");
    });

    // Calculate arrowheads for each target
    const arrowheads = createMemo(() => {
        const targets = targetPositions();
        const vertices = vertexPositions();
        const sources = sourcePositions();

        if (targets.length === 0) return [];
        const holdTargets = targets.filter((tgt) => tgt !== null);
        const holdSources = sources.filter((tgt) => tgt !== null);
        return holdTargets
            .map((tgt) => {
                // Find the point before this target
                let prevPoint;
                if (vertices.length > 0) {
                    prevPoint = vertices[vertices.length - 1];
                } else {
                    prevPoint = holdSources[0];
                }

                const dx = tgt.x - prevPoint.x;
                const dy = tgt.y - prevPoint.y;
                const angle = Math.atan2(dy, dx);

                const arrowLength = 12;

                const x1 = tgt.x - arrowLength * Math.cos(angle - Math.PI / 6);
                const y1 = tgt.y - arrowLength * Math.sin(angle - Math.PI / 6);
                const x2 = tgt.x - arrowLength * Math.cos(angle + Math.PI / 6);
                const y2 = tgt.y - arrowLength * Math.sin(angle + Math.PI / 6);

                return `M ${tgt.x} ${tgt.y} L ${x1} ${y1} L ${x2} ${y2} Z`;
            })
            .filter(Boolean);
    });

    const strokeDasharray = () => {
        if (props.connection.style === "dashed") return "8,4";
        if (props.connection.style === "dotted") return "2,4";
        return "none";
    };

    // Handle double-click on path to create vertex
    const handlePathDoubleClick = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        // Get SVG element to calculate canvas-relative coordinates
        const svgElement = (e.currentTarget as SVGPathElement).ownerSVGElement;
        if (!svgElement) return;

        const svgRect = svgElement.getBoundingClientRect();
        const canvasRelativeX = e.clientX - svgRect.left;
        const canvasRelativeY = e.clientY - svgRect.top;

        // Convert canvas-relative coordinates to world coordinates
        const worldPos = screenToWorld(
            canvasRelativeX,
            canvasRelativeY,
            props.viewport()
        );

        props.onCreateVertex(props.connection.id, worldPos.x, worldPos.y);
        setContextMenu(null);
    };

    // Handle right-click context menu on connection path
    const handleConnectionContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Store SVG reference for later coordinate conversion
        const svgElement = (e.currentTarget as SVGPathElement).ownerSVGElement;
        if (svgElement) {
            svgElementRef = svgElement;
        }

        setContextMenu({
            position: { x: e.clientX, y: e.clientY },
            type: "connection"
        });
    };

    // Handle vertex right-click context menu
    const handleVertexContextMenu = (vertexId: string, e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
            position: { x: e.clientX, y: e.clientY },
            type: "vertex",
            vertexId
        });
    };

    return (
        <>
            <g
                class="pointer-events-auto"
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                {/* Connection path */}
                <path
                    d={path()}
                    stroke={isHovered() ? "#0f766e" : "#2dd4bf"}
                    stroke-width={isHovered() ? "3" : "2"}
                    fill="none"
                    stroke-dasharray={strokeDasharray()}
                    class="cursor-pointer"
                    onDblClick={(e) => {
                        handlePathDoubleClick(e);
                    }}
                    onContextMenu={(e) => {
                        handleConnectionContextMenu(e);
                    }}
                    onClick={(e) => {
                        // Only handle left clicks in connection mode
                        if (
                            e.button === 0 &&
                            props.isConnectionMode &&
                            props.onConnectionClick
                        ) {
                            e.stopPropagation();
                            props.onConnectionClick(props.connection.id);
                        }
                    }}
                />

                {/* Arrowheads */}
                <For each={arrowheads()}>
                    {(arrowhead) => (
                        <path
                            d={arrowhead}
                            stroke={isHovered() ? "#0f766e" : "#2dd4bf"}
                            fill={isHovered() ? "#0f766e" : "#2dd4bf"}
                            class="pointer-events-none"
                        />
                    )}
                </For>

                {/* Vertices */}
                <For each={props.connection.vertices}>
                    {(vertex) => (
                        <VertexComponent
                            connectionId={props.connection.id}
                            vertex={vertex}
                            viewport={props.viewport}
                            onDragStart={props.onVertexDragStart}
                            isHovered={hoveredVertex() === vertex.id}
                            onHover={(hover) =>
                                setHoveredVertex(hover ? vertex.id : null)
                            }
                            isConnectionMode={props.isConnectionMode}
                            isSelected={props.selectedVertexId === vertex.id}
                            onVertexClick={props.onVertexClick}
                            onContextMenu={handleVertexContextMenu}
                        />
                    )}
                </For>
            </g>

            <Show when={contextMenu()}>
                <Portal>
                    <ContextMenu
                        position={contextMenu()?.position ?? { x: 0, y: 0 }}
                        actions={[
                            contextMenu()?.type === "vertex"
                                ? {
                                      label: "Delete Vertex",
                                      action: () => {
                                          props.onDeleteVertex(
                                              props.connection.id,
                                              contextMenu()?.vertexId ?? ""
                                          );
                                          setContextMenu(null);
                                      },
                                      destructive: true
                                  }
                                : {
                                      label: "Create Vertex",
                                      action: () => {
                                          const menu = contextMenu()!;

                                          // Convert viewport coordinates to canvas-relative coordinates
                                          let canvasRelativeX = menu.position.x;
                                          let canvasRelativeY = menu.position.y;

                                          if (svgElementRef) {
                                              const svgRect =
                                                  svgElementRef.getBoundingClientRect();
                                              canvasRelativeX =
                                                  menu.position.x - svgRect.left;
                                              canvasRelativeY =
                                                  menu.position.y - svgRect.top;
                                          }

                                          const worldPos = screenToWorld(
                                              canvasRelativeX,
                                              canvasRelativeY,
                                              props.viewport()
                                          );
                                          props.onCreateVertex(
                                              props.connection.id,
                                              worldPos.x,
                                              worldPos.y
                                          );
                                          setContextMenu(null);
                                      }
                                  },
                            {
                                label: "Delete Connection",
                                action: () => {
                                    props.onDeleteConnection(props.connection.id);
                                    setContextMenu(null);
                                },
                                destructive: true
                            }
                        ]}
                        onClose={() => setContextMenu(null)}
                    />
                </Portal>
            </Show>
        </>
    );
};

export const ConnectionPreview = (props: {
    startDraft: CanvasDraft;
    startGroup?: CanvasGroup | null;
    sourceAnchor: { type: AnchorType } | null;
    mousePos: { x: number; y: number } | null;
    viewport: () => Viewport;
    layoutToggle: () => boolean;
}) => {
    const startPos = () => {
        if (!props.sourceAnchor) {
            const vp = props.viewport();
            const currentWidth = cardWidth(props.layoutToggle());
            const currentHeight = cardHeight(props.layoutToggle());
            let baseX = props.startDraft.positionX;
            let baseY = props.startDraft.positionY;
            if (props.startGroup) {
                baseX += props.startGroup.positionX;
                baseY += props.startGroup.positionY;
            }
            return {
                x: (baseX + currentWidth / 2 - vp.x) * vp.zoom,
                y: (baseY + currentHeight / 2 - vp.y) * vp.zoom
            };
        }

        return getAnchorScreenPosition(
            props.startDraft,
            props.sourceAnchor.type,
            props.layoutToggle(),
            props.viewport(),
            props.startGroup
        );
    };

    return (
        <Show when={props.mousePos}>
            <line
                x1={startPos().x}
                y1={startPos().y}
                x2={props.mousePos?.x ?? 0}
                y2={props.mousePos?.y ?? 0}
                stroke="#3b82f6"
                stroke-width="2"
                stroke-dasharray="4,4"
                class="pointer-events-none"
            />
        </Show>
    );
};

export const GroupConnectionPreview = (props: {
    startGroup: CanvasGroup;
    sourceAnchor: { type: AnchorType } | null;
    mousePos: { x: number; y: number } | null;
    viewport: () => Viewport;
}) => {
    const startPos = () => {
        if (!props.sourceAnchor) {
            const vp = props.viewport();
            const w = props.startGroup.width ?? 400;
            const h = props.startGroup.height ?? 200;
            return {
                x: (props.startGroup.positionX + w / 2 - vp.x) * vp.zoom,
                y: (props.startGroup.positionY + h / 2 - vp.y) * vp.zoom
            };
        }

        return getGroupAnchorScreenPosition(
            props.startGroup,
            props.sourceAnchor.type,
            props.viewport()
        );
    };

    return (
        <Show when={props.mousePos}>
            <line
                x1={startPos().x}
                y1={startPos().y}
                x2={props.mousePos?.x ?? 0}
                y2={props.mousePos?.y ?? 0}
                stroke="#3b82f6"
                stroke-width="2"
                stroke-dasharray="4,4"
                class="pointer-events-none"
            />
        </Show>
    );
};
