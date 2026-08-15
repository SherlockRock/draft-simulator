import { createSignal, Show, createMemo, For } from "solid-js";
import {
    CanvasAnnotation,
    CanvasDraft,
    CanvasGroup,
    Connection,
    AnchorType
} from "../utils/schemas";
import {
    getAnchorWorldPosition,
    getAnnotationAnchorWorldPosition,
    getGroupAnchorWorldPosition,
    getSeriesGroupDimensions,
    getSeriesDraftWorldPosition,
    getSeriesDraftAnchorWorldPosition,
    cardWidth,
    cardHeight
} from "../utils/helpers";
import { sortedSeriesDrafts } from "../utils/canvasWorldPosition";
import { VertexComponent } from "./Vertex";
import type { CardLayout } from "../utils/canvasCardLayout";

/*
 * Connections render in WORLD coordinates. The SVG they live in sits inside the
 * `.canvas-world` layer, so panning is a compositor transform on that one
 * element and nothing here recomputes. Nothing in this file may read the
 * viewport — a `props.viewport()` read would re-run these memos on every pan
 * frame and undo the whole point.
 *
 * `zoom` is still read, because stroke widths, dash patterns and arrowheads are
 * screen-px constants that must be divided by zoom to survive the layer's
 * `scale()`. Zoom is stable during a pan, and the shared zoom memo in Canvas.tsx
 * is `===`-equal across pan frames, so those reads cost nothing while panning.
 */

export const ConnectionComponent = (props: {
    connection: Connection;
    annotations: CanvasAnnotation[];
    drafts: CanvasDraft[];
    groups: CanvasGroup[];
    zoom: () => number;
    screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
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
                return getGroupAnchorWorldPosition(
                    { ...group, width: dims.width, height: dims.height },
                    endpoint.anchor_type
                );
            }
            return getGroupAnchorWorldPosition(group, endpoint.anchor_type);
        }
        if (endpoint.type === "annotation") {
            const note = props.annotations.find(
                (entry) => entry.id === endpoint.annotation_id
            );
            if (!note) return null;
            const group = note.group_id
                ? (props.groups.find((entry) => entry.id === note.group_id) ?? null)
                : null;
            return getAnnotationAnchorWorldPosition(note, endpoint.anchor_type, group);
        }
        const draft = findDraft(endpoint.draft_id);
        if (!draft) return null;
        const group = findGroupForDraft(draft);
        // Series group drafts: compute position from flexbox layout
        if (group?.type === "series") {
            // A seventh verbatim copy of the series comparator used to live
            // here. Behaviourally identical to `sortedSeriesDrafts`, which is
            // exactly why it was one edit away from being the eighth divergence
            // (plan A11).
            const groupDrafts = sortedSeriesDrafts(
                props.drafts.filter((d) => d.group_id === group.id)
            );
            const index = groupDrafts.findIndex((d) => d.Draft.id === draft.Draft.id);
            return getSeriesDraftAnchorWorldPosition(
                group,
                index,
                endpoint.anchor_type,
                props.cardLayout()
            );
        }
        return getAnchorWorldPosition(
            draft,
            endpoint.anchor_type,
            props.cardLayout(),
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

    // Vertices are already stored in world coords, so they need no conversion
    const vertexPositions = createMemo(() => {
        if (!props.connection) return [];
        return props.connection.vertices.map((v) => ({ x: v.x, y: v.y }));
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

                // 12 screen px, expressed in world units
                const arrowLength = 12 / props.zoom();

                const x1 = tgt.x - arrowLength * Math.cos(angle - Math.PI / 6);
                const y1 = tgt.y - arrowLength * Math.sin(angle - Math.PI / 6);
                const x2 = tgt.x - arrowLength * Math.cos(angle + Math.PI / 6);
                const y2 = tgt.y - arrowLength * Math.sin(angle + Math.PI / 6);

                return `M ${tgt.x} ${tgt.y} L ${x1} ${y1} L ${x2} ${y2} Z`;
            })
            .filter(Boolean);
    });

    // Dash patterns are screen-px lengths, so they scale down with zoom
    const strokeDasharray = () => {
        const s = 1 / props.zoom();
        if (props.connection.style === "dashed") return `${8 * s},${4 * s}`;
        if (props.connection.style === "dotted") return `${2 * s},${4 * s}`;
        return "none";
    };

    const strokeWidth = () => (isHovered() ? 3 : 2) / props.zoom();

    // Handle double-click on path to create vertex.
    // The SVG's own rect is useless here — it is a nominal 1x1 element whose
    // content paints as overflow — so go through the canvas container instead.
    const handlePathDoubleClick = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        const worldPos = props.screenToWorld(e.clientX, e.clientY);
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
                stroke-width={strokeWidth()}
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
                        stroke-width={1 / props.zoom()}
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
                        zoom={props.zoom}
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
    /** World coordinates, like every other point in this file. */
    mousePos: { x: number; y: number } | null;
    zoom: () => number;
    cardLayout: () => CardLayout;
    seriesDraftIndex?: number;
}) => {
    const startPos = () => {
        const isSeriesGroup = props.startGroup?.type === "series";
        const seriesIndex = props.seriesDraftIndex ?? 0;

        if (!props.sourceAnchor) {
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
                x: baseX + currentWidth / 2,
                y: baseY + currentHeight / 2
            };
        }

        if (isSeriesGroup && props.startGroup) {
            return getSeriesDraftAnchorWorldPosition(
                props.startGroup,
                seriesIndex,
                props.sourceAnchor.type,
                props.cardLayout()
            );
        }

        return getAnchorWorldPosition(
            props.startDraft,
            props.sourceAnchor.type,
            props.cardLayout(),
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
                stroke-width={2 / props.zoom()}
                stroke-dasharray={`${4 / props.zoom()},${4 / props.zoom()}`}
                class="pointer-events-none stroke-darius-purple-bright"
            />
        </Show>
    );
};

export const GroupConnectionPreview = (props: {
    startGroup: CanvasGroup;
    sourceAnchor: { type: AnchorType } | null;
    /** World coordinates, like every other point in this file. */
    mousePos: { x: number; y: number } | null;
    zoom: () => number;
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
            const w = group.width ?? 400;
            const h = group.height ?? 200;
            return {
                x: group.positionX + w / 2,
                y: group.positionY + h / 2
            };
        }

        return getGroupAnchorWorldPosition(group, props.sourceAnchor.type);
    };

    return (
        <Show when={props.mousePos}>
            <line
                x1={startPos().x}
                y1={startPos().y}
                x2={props.mousePos?.x ?? 0}
                y2={props.mousePos?.y ?? 0}
                stroke-width={2 / props.zoom()}
                stroke-dasharray={`${4 / props.zoom()},${4 / props.zoom()}`}
                class="pointer-events-none stroke-darius-purple-bright"
            />
        </Show>
    );
};
