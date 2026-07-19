import { createSignal, Show, createMemo, For } from "solid-js";
import {
    CanvasDraft,
    CanvasGroup,
    Connection,
    Viewport,
    AnchorType
} from "../utils/schemas";
import {
    getAnchorScreenPosition,
    getGroupAnchorScreenPosition,
    getSeriesGroupDimensions,
    getSeriesDraftWorldPosition,
    getSeriesDraftAnchorWorldPosition,
    worldToScreen,
    screenToWorld,
    cardWidth,
    cardHeight
} from "../utils/helpers";
import { VertexComponent } from "./Vertex";
import type { CardLayout } from "../utils/canvasCardLayout";

export const ConnectionComponent = (props: {
    connection: Connection;
    drafts: CanvasDraft[];
    groups: CanvasGroup[];
    viewport: () => Viewport;
    onCreateVertex: (connectionId: string, x: number, y: number) => void;
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
    cardLayout: () => CardLayout;
}) => {
    const [isHovered, setIsHovered] = createSignal(false);
    const [hoveredVertex, setHoveredVertex] = createSignal<string | null>(null);

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
            // Series groups need computed dimensions (no stored width/height)
            if (group.type === "series") {
                const groupDrafts = props.drafts.filter((d) => d.group_id === group.id);
                const dims = getSeriesGroupDimensions(
                    groupDrafts.length,
                    props.cardLayout()
                );
                return getGroupAnchorScreenPosition(
                    { ...group, width: dims.width, height: dims.height },
                    endpoint.anchor_type,
                    props.viewport()
                );
            }
            return getGroupAnchorScreenPosition(
                group,
                endpoint.anchor_type,
                props.viewport()
            );
        }
        const draft = findDraft(endpoint.draft_id);
        if (!draft) return null;
        const group = findGroupForDraft(draft);
        // Series group drafts: compute position from flexbox layout
        if (group?.type === "series") {
            const groupDrafts = props.drafts
                .filter((d) => d.group_id === group.id)
                .sort((a, b) => {
                    const aIndex = a.Draft.seriesIndex;
                    const bIndex = b.Draft.seriesIndex;
                    if (aIndex === null || aIndex === undefined) {
                        return bIndex === null || bIndex === undefined ? 0 : 1;
                    }
                    if (bIndex === null || bIndex === undefined) return -1;
                    return aIndex - bIndex;
                });
            const index = groupDrafts.findIndex((d) => d.Draft.id === draft.Draft.id);
            const worldPos = getSeriesDraftAnchorWorldPosition(
                group,
                index,
                endpoint.anchor_type,
                props.cardLayout()
            );
            return worldToScreen(worldPos.x, worldPos.y, props.viewport());
        }
        return getAnchorScreenPosition(
            draft,
            endpoint.anchor_type,
            props.cardLayout(),
            props.viewport(),
            group
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
    };

    return (
        <g
            class="pointer-events-auto"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Connection path */}
            <path
                data-connection-id={props.connection.id}
                d={path()}
                stroke-width={isHovered() ? "3" : "2"}
                fill="none"
                stroke-dasharray={strokeDasharray()}
                class="cursor-pointer"
                classList={{
                    "stroke-darius-ember": !isHovered(),
                    "stroke-darius-crimson": isHovered()
                }}
                onDblClick={(e) => {
                    handlePathDoubleClick(e);
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
                        class="pointer-events-none"
                        classList={{
                            "stroke-darius-ember fill-darius-ember": !isHovered(),
                            "stroke-darius-crimson fill-darius-crimson": isHovered()
                        }}
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
                        onHover={(hover) => setHoveredVertex(hover ? vertex.id : null)}
                        isConnectionMode={props.isConnectionMode}
                        isSelected={props.selectedVertexId === vertex.id}
                        onVertexClick={props.onVertexClick}
                    />
                )}
            </For>
        </g>
    );
};

export const ConnectionPreview = (props: {
    startDraft: CanvasDraft;
    startGroup?: CanvasGroup | null;
    sourceAnchor: { type: AnchorType } | null;
    mousePos: { x: number; y: number } | null;
    viewport: () => Viewport;
    cardLayout: () => CardLayout;
    seriesDraftIndex?: number;
}) => {
    const startPos = () => {
        const isSeriesGroup = props.startGroup?.type === "series";
        const seriesIndex = props.seriesDraftIndex ?? 0;

        if (!props.sourceAnchor) {
            const vp = props.viewport();
            const currentWidth = cardWidth(props.cardLayout());
            const currentHeight = cardHeight(props.cardLayout());
            let baseX: number;
            let baseY: number;
            if (isSeriesGroup && props.startGroup) {
                const pos = getSeriesDraftWorldPosition(
                    props.startGroup,
                    seriesIndex,
                    props.cardLayout()
                );
                baseX = pos.x;
                baseY = pos.y;
            } else {
                baseX = props.startDraft.positionX;
                baseY = props.startDraft.positionY;
                if (props.startGroup) {
                    baseX += props.startGroup.positionX;
                    baseY += props.startGroup.positionY;
                }
            }
            return {
                x: (baseX + currentWidth / 2 - vp.x) * vp.zoom,
                y: (baseY + currentHeight / 2 - vp.y) * vp.zoom
            };
        }

        if (isSeriesGroup && props.startGroup) {
            const worldPos = getSeriesDraftAnchorWorldPosition(
                props.startGroup,
                seriesIndex,
                props.sourceAnchor.type,
                props.cardLayout()
            );
            return worldToScreen(worldPos.x, worldPos.y, props.viewport());
        }

        return getAnchorScreenPosition(
            props.startDraft,
            props.sourceAnchor.type,
            props.cardLayout(),
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
                stroke-width="2"
                stroke-dasharray="4,4"
                class="pointer-events-none stroke-darius-purple-bright"
            />
        </Show>
    );
};

export const GroupConnectionPreview = (props: {
    startGroup: CanvasGroup;
    sourceAnchor: { type: AnchorType } | null;
    mousePos: { x: number; y: number } | null;
    viewport: () => Viewport;
    seriesDraftCount?: number;
    cardLayout?: () => CardLayout;
}) => {
    const effectiveGroup = () => {
        if (
            props.startGroup.type === "series" &&
            props.seriesDraftCount !== undefined &&
            props.cardLayout
        ) {
            const dims = getSeriesGroupDimensions(
                props.seriesDraftCount,
                props.cardLayout()
            );
            return { ...props.startGroup, width: dims.width, height: dims.height };
        }
        return props.startGroup;
    };

    const startPos = () => {
        const group = effectiveGroup();
        if (!props.sourceAnchor) {
            const vp = props.viewport();
            const w = group.width ?? 400;
            const h = group.height ?? 200;
            return {
                x: (group.positionX + w / 2 - vp.x) * vp.zoom,
                y: (group.positionY + h / 2 - vp.y) * vp.zoom
            };
        }

        return getGroupAnchorScreenPosition(
            group,
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
                stroke-width="2"
                stroke-dasharray="4,4"
                class="pointer-events-none stroke-darius-purple-bright"
            />
        </Show>
    );
};
