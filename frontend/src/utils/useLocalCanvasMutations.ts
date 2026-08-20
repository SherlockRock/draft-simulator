import {
    CanvasDraft,
    CanvasAnnotation,
    CanvasPoolPlacement,
    Connection,
    ConnectionEndpoint,
    CanvasGroup,
    Viewport,
    AnchorType
} from "./schemas";
import { getLocalCanvas, saveLocalCanvas, LocalCanvas } from "./localCanvasStore";
import type { CardLayout } from "./canvasCardLayout";
import type {
    CanvasGroupMetadata,
    CanvasGroupMetadataUpdate,
    AnnotationColor,
    AnnotationFontSize,
    AnnotationPositionUpdate,
    DraftPositionUpdate,
    GameType,
    GroupPositionUpdate,
    PoolChampionOp,
    RolePoolMap
} from "@draft-sim/shared-types";
import { applyPoolChampionOp, EMPTY_ROLE_POOL_MAP } from "@draft-sim/shared-types";
import { getManualSeriesGameDefaults } from "./manualSeriesDefaults";
import { childAnnotationsOf, childGroupsOf } from "./canvasTree";
import { parentageRejection } from "./groupParentage";
import {
    GROUP_BORDER_WIDTH,
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_X,
    SERIES_PADDING_Y
} from "./helpers";

// Helper to safely cast anchor type with default
const toAnchorType = (
    value: string | undefined,
    defaultValue: AnchorType
): AnchorType => {
    if (value === "top" || value === "bottom" || value === "left" || value === "right") {
        return value;
    }
    return defaultValue;
};

/**
 * Drop endpoints whose target has just been deleted, mirroring the server's own
 * cleanup in the draft-delete (`canvas.js:1249`) and group-delete
 * (`canvas.js:2110`) routes: a connection dies only when a WHOLE side empties,
 * otherwise it is trimmed and kept. Dropping the connection whenever any single
 * endpoint matched — what this file used to do — silently deleted the
 * multi-endpoint connections `localUpdateConnection` can build.
 */
const pruneConnectionEndpoints = (
    connections: Connection[],
    isRemoved: (endpoint: ConnectionEndpoint) => boolean
): Connection[] =>
    connections.flatMap((connection) => {
        const sources = connection.source_draft_ids.filter((e) => !isRemoved(e));
        const targets = connection.target_draft_ids.filter((e) => !isRemoved(e));
        if (sources.length === 0 || targets.length === 0) return [];
        if (
            sources.length === connection.source_draft_ids.length &&
            targets.length === connection.target_draft_ids.length
        ) {
            return [connection];
        }
        return [{ ...connection, source_draft_ids: sources, target_draft_ids: targets }];
    });

// Helper: read, apply, save, return
const mutateLocal = <T>(
    fn: (canvas: LocalCanvas) => { canvas: LocalCanvas; result: T }
): T => {
    const canvas = getLocalCanvas();
    if (!canvas) throw new Error("No local canvas");
    const { canvas: updated, result } = fn(canvas);
    saveLocalCanvas(updated);
    return result;
};

export const localUpdateCanvasName = (data: {
    name: string;
    description?: string;
    icon?: string;
}) => {
    return mutateLocal((canvas) => {
        canvas.name = data.name;
        if (data.description !== undefined) canvas.description = data.description;
        if (data.icon !== undefined) canvas.icon = data.icon;
        return { canvas, result: { name: canvas.name, id: "local" } };
    });
};

export const localUpdateCardLayout = (cardLayout: CardLayout) => {
    return mutateLocal((canvas) => {
        canvas.cardLayout = cardLayout;
        return { canvas, result: { success: true, cardLayout } };
    });
};

export const localNewDraft = (data: {
    name: string;
    picks: string[];
    positionX: number;
    positionY: number;
    group_id?: string | null;
}) => {
    return mutateLocal((canvas) => {
        const draftId = crypto.randomUUID();
        const newDraft: CanvasDraft = {
            draft_id: draftId,
            positionX: data.positionX,
            positionY: data.positionY,
            group_id: data.group_id ?? null,
            source_type: "canvas",
            Draft: {
                id: draftId,
                name: data.name,
                picks: data.picks,
                type: "canvas"
            }
        };
        canvas.drafts.push(newDraft);
        return { canvas, result: newDraft };
    });
};

export const localEditDraft = (draftId: string, data: { name: string }) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === draftId);
        if (draft) {
            draft.Draft.name = data.name;
        }
        return { canvas, result: draft };
    });
};

export const localUpdateDraftPosition = (data: {
    draftId: string;
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === data.draftId);
        if (draft) {
            draft.positionX = data.positionX;
            draft.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};

export const localDeleteDraft = (draftId: string) => {
    return mutateLocal((canvas) => {
        canvas.drafts = canvas.drafts.filter((d) => d.Draft.id !== draftId);
        // Also remove connections referencing this draft — trimmed, not dropped
        // wholesale, exactly as canvas.js:1249 does it.
        canvas.connections = pruneConnectionEndpoints(
            canvas.connections,
            (e) => "draft_id" in e && e.draft_id === draftId
        );
        return { canvas, result: { success: true } };
    });
};

const COPY_OFFSET = 50;

export const localCopyDraft = (
    draftId: string,
    placement?: { positionX: number; positionY: number; group_id: string | null }
) => {
    return mutateLocal((canvas) => {
        const originalDraft = canvas.drafts.find((d) => d.Draft.id === draftId);
        if (!originalDraft) {
            throw new Error("Draft not found");
        }

        const newDraftId = crypto.randomUUID();
        const newDraft: CanvasDraft = {
            draft_id: newDraftId,
            positionX: placement
                ? placement.positionX
                : originalDraft.positionX + COPY_OFFSET,
            positionY: placement
                ? placement.positionY
                : originalDraft.positionY + COPY_OFFSET,
            group_id: placement ? placement.group_id : (originalDraft.group_id ?? null),
            team1Name: originalDraft.team1Name,
            team2Name: originalDraft.team2Name,
            source_type: "canvas",
            Draft: {
                id: newDraftId,
                name: `${originalDraft.Draft.name} (Copy)`,
                picks: [...originalDraft.Draft.picks],
                type: "canvas"
            }
        };
        canvas.drafts.push(newDraft);
        return { canvas, result: { success: true, canvasDraft: newDraft } };
    });
};

export const localCreateAnnotation = (data: {
    positionX: number;
    positionY: number;
    width: number;
    height: number;
    group_id: string | null;
}) => {
    return mutateLocal((canvas) => {
        const annotation: CanvasAnnotation = {
            id: crypto.randomUUID(),
            canvas_id: "local",
            group_id: data.group_id,
            positionX: data.positionX,
            positionY: data.positionY,
            width: data.width,
            height: data.height,
            text: "",
            color: "slate",
            fontSize: "md"
        };
        canvas.annotations.push(annotation);
        return { canvas, result: { success: true, annotation } };
    });
};

export const localUpdateAnnotation = (data: {
    annotationId: string;
    positionX?: number;
    positionY?: number;
    width?: number;
    height?: number;
    manualWidth?: number | null;
    manualHeight?: number | null;
    text?: string;
    color?: AnnotationColor;
    fontSize?: AnnotationFontSize;
    group_id?: string | null;
}) => {
    return mutateLocal((canvas) => {
        const annotation = canvas.annotations.find(
            (entry) => entry.id === data.annotationId
        );
        if (annotation) {
            if (data.positionX !== undefined) annotation.positionX = data.positionX;
            if (data.positionY !== undefined) annotation.positionY = data.positionY;
            if (data.width !== undefined) annotation.width = data.width;
            if (data.height !== undefined) annotation.height = data.height;
            if (data.manualWidth !== undefined) annotation.manualWidth = data.manualWidth;
            if (data.manualHeight !== undefined) {
                annotation.manualHeight = data.manualHeight;
            }
            if (data.text !== undefined) annotation.text = data.text;
            if (data.color !== undefined) annotation.color = data.color;
            if (data.fontSize !== undefined) annotation.fontSize = data.fontSize;
            if (data.group_id !== undefined) annotation.group_id = data.group_id;
        }
        return { canvas, result: { success: true } };
    });
};

export const localDeleteAnnotation = (annotationId: string) => {
    return mutateLocal((canvas) => {
        canvas.annotations = canvas.annotations.filter(
            (entry) => entry.id !== annotationId
        );
        canvas.connections = pruneConnectionEndpoints(
            canvas.connections,
            (endpoint) =>
                "annotation_id" in endpoint && endpoint.annotation_id === annotationId
        );
        return { canvas, result: { success: true } };
    });
};

export const localCopyAnnotation = (
    annotationId: string,
    placement: { positionX: number; positionY: number; group_id: string | null }
) => {
    return mutateLocal((canvas) => {
        const source = canvas.annotations.find((entry) => entry.id === annotationId);
        if (!source) throw new Error("Annotation not found");
        const copy: CanvasAnnotation = {
            ...source,
            id: crypto.randomUUID(),
            positionX: placement.positionX,
            positionY: placement.positionY,
            group_id: placement.group_id
        };
        canvas.annotations.push(copy);
        return { canvas, result: { success: true, annotation: copy } };
    });
};

export const localUpdateViewport = (viewport: Viewport) => {
    return mutateLocal((canvas) => {
        canvas.viewport = viewport;
        return { canvas, result: { success: true } };
    });
};

type LocalConnectionEndpointInput =
    | { draftId: string; anchorType?: string }
    | { groupId: string; anchorType?: string }
    | { annotationId: string; anchorType?: string };

const formatLocalEndpoint = (
    endpoint: LocalConnectionEndpointInput,
    defaultAnchor: AnchorType
): ConnectionEndpoint => {
    if ("groupId" in endpoint) {
        return {
            type: "group",
            group_id: endpoint.groupId,
            anchor_type: toAnchorType(endpoint.anchorType, defaultAnchor)
        };
    }
    if ("annotationId" in endpoint) {
        return {
            type: "annotation",
            annotation_id: endpoint.annotationId,
            anchor_type: toAnchorType(endpoint.anchorType, defaultAnchor)
        };
    }
    return {
        draft_id: endpoint.draftId,
        anchor_type: toAnchorType(endpoint.anchorType, defaultAnchor)
    };
};

export const localCreateConnection = (data: {
    sourceDraftIds: LocalConnectionEndpointInput[];
    targetDraftIds: LocalConnectionEndpointInput[];
    style?: "solid" | "dashed" | "dotted";
    vertices?: Array<{ id: string; x: number; y: number }>;
}) => {
    return mutateLocal((canvas) => {
        const connectionId = crypto.randomUUID();
        const connection: Connection = {
            id: connectionId,
            canvas_id: "local",
            source_draft_ids: data.sourceDraftIds.map((endpoint) =>
                formatLocalEndpoint(endpoint, "bottom")
            ),
            target_draft_ids: data.targetDraftIds.map((endpoint) =>
                formatLocalEndpoint(endpoint, "top")
            ),
            vertices: data.vertices ?? [],
            style: data.style ?? "solid"
        };
        canvas.connections.push(connection);
        return { canvas, result: { success: true, connection } };
    });
};

export const localUpdateConnection = (data: {
    connectionId: string;
    addSource?: LocalConnectionEndpointInput;
    addTarget?: LocalConnectionEndpointInput;
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            if (data.addSource) {
                const endpoint = formatLocalEndpoint(data.addSource, "bottom");
                conn.source_draft_ids.push(endpoint);
            }
            if (data.addTarget) {
                const endpoint = formatLocalEndpoint(data.addTarget, "top");
                conn.target_draft_ids.push(endpoint);
            }
        }
        return { canvas, result: { success: true, connection: conn } };
    });
};

export const localDeleteConnection = (connectionId: string) => {
    return mutateLocal((canvas) => {
        canvas.connections = canvas.connections.filter((c) => c.id !== connectionId);
        return { canvas, result: { success: true } };
    });
};

export const localCreateVertex = (data: {
    connectionId: string;
    x: number;
    y: number;
    insertAfterIndex?: number;
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        const vertexId = crypto.randomUUID();
        const vertex = { id: vertexId, x: data.x, y: data.y };
        if (conn) {
            const idx = data.insertAfterIndex ?? conn.vertices.length;
            conn.vertices.splice(idx + 1, 0, vertex);
        }
        return { canvas, result: { success: true, vertex, connection: conn } };
    });
};

export const localUpdateVertex = (data: {
    connectionId: string;
    vertexId: string;
    x: number;
    y: number;
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            const vertex = conn.vertices.find((v) => v.id === data.vertexId);
            if (vertex) {
                vertex.x = data.x;
                vertex.y = data.y;
            }
        }
        return {
            canvas,
            result: { success: true, vertex: { id: data.vertexId, x: data.x, y: data.y } }
        };
    });
};

export const localDeleteVertex = (data: { connectionId: string; vertexId: string }) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            conn.vertices = conn.vertices.filter((v) => v.id !== data.vertexId);
        }
        return { canvas, result: { success: true, connection: conn } };
    });
};

/**
 * `parentId` nests the new Group. A local canvas has no server to validate
 * against, so the same predicate the routes use runs here and THROWS the
 * server's own wording — otherwise an anonymous user can build a tree the
 * server would have refused, and only find out at sign-up (5a-5).
 */
export const localCreateGroup = (data: {
    positionX: number;
    positionY: number;
    parentId?: string | null;
    /** Absent falls back to the auto-numbered "New Group N". */
    name?: string;
    /**
     * What the Group is born with — the local twin of the create route's
     * `metadata` (design §10, 5c). Without it a locally created Group is born
     * `free` while a server one is born `grid`, and the two diverge at sign-up.
     */
    metadata?: CanvasGroupMetadataUpdate;
    /**
     * The size to create it at. Absent leaves width/height unset, which is what
     * every local Group used to get and what the renderer's DEFAULT_GROUP_*
     * fallback covers; a grid container sends the size its rows and columns
     * need so it opens as the grid it was configured to be.
     */
    width?: number;
    height?: number;
}) => {
    return mutateLocal((canvas) => {
        const existingNames = new Set(canvas.groups.map((g) => g.name));
        let name = data.name?.trim() || "New Group";
        if (!data.name?.trim() && existingNames.has(name)) {
            let counter = 1;
            while (existingNames.has(`New Group ${counter}`)) {
                counter++;
            }
            name = `New Group ${counter}`;
        }
        const id = crypto.randomUUID();
        const parentId = data.parentId ?? null;
        if (parentId !== null) {
            const rejection = parentageRejection(
                {
                    groups: canvas.groups,
                    drafts: canvas.drafts,
                    annotations: canvas.annotations
                },
                id,
                parentId
            );
            if (rejection) throw new Error(rejection);
        }
        const group: CanvasGroup = {
            id,
            canvas_id: "local",
            name,
            type: "custom",
            positionX: data.positionX,
            positionY: data.positionY,
            // ADR-0006: absolute world at every depth, so a nested create
            // stores the position it was given, unrebased.
            parent_group_id: parentId,
            ...(data.width !== undefined ? { width: data.width } : {}),
            ...(data.height !== undefined ? { height: data.height } : {}),
            // Same clear protocol as the server's create: a `gameType: null`
            // means "no classification", never a stored null.
            metadata: mergeLocalGroupMetadata({}, data.metadata ?? {})
        };
        canvas.groups.push(group);
        return { canvas, result: { success: true, group } };
    });
};

/**
 * Local mirror of the backend's clear protocol (D3): an inbound `null` deletes
 * the key rather than storing a null, so local metadata keeps the same
 * enum-or-absent shape the read schema expects.
 *
 * Two keys are clearable. `gameType` always was; `draftMode` joined it when the
 * settings dialog stopped offering draft mode for custom groups — a custom
 * group that already stored `fearless` has to be able to stop restricting, and
 * through a shallow merge only an explicit null can say so.
 *
 * Written out per key rather than looped over a list: the value types differ,
 * and a loop would need a cast to index into the merged object.
 */
const mergeLocalGroupMetadata = (
    stored: CanvasGroupMetadata,
    incoming: CanvasGroupMetadataUpdate
): CanvasGroupMetadata => {
    const { gameType, draftMode, ...rest } = incoming;
    const merged: CanvasGroupMetadata = { ...stored, ...rest };
    if (gameType === null) delete merged.gameType;
    else if (gameType !== undefined) merged.gameType = gameType;
    if (draftMode === null) delete merged.draftMode;
    else if (draftMode !== undefined) merged.draftMode = draftMode;
    return merged;
};

export const localUpdateGroup = (data: {
    groupId: string;
    name?: string;
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
    metadata?: CanvasGroupMetadataUpdate;
}) => {
    return mutateLocal((canvas) => {
        const group = canvas.groups.find((g) => g.id === data.groupId);
        if (group) {
            if (data.name !== undefined) group.name = data.name;
            if (data.positionX !== undefined) group.positionX = data.positionX;
            if (data.positionY !== undefined) group.positionY = data.positionY;
            if (data.width !== undefined) group.width = data.width;
            if (data.height !== undefined) group.height = data.height;
            if (data.metadata !== undefined)
                group.metadata = mergeLocalGroupMetadata(group.metadata, data.metadata);
        }
        return { canvas, result: { success: true, group } };
    });
};

export const localConvertGroupToSeries = (data: {
    groupId: string;
    name: string;
    blueTeamName: string;
    redTeamName: string;
    length: number;
    draftMode: "standard" | "fearless" | "ironman";
    disabledChampions: string[];
    /**
     * Carried because this is the ONLY path for editing an existing local
     * series (Canvas.tsx routes here whenever group.type === "series"), so
     * without it a local user's choice is silently dropped on save. `null`
     * clears. Deliberately NOT defaulted to a value — D6 keeps local groups
     * untagged unless the user says otherwise.
     */
    gameType?: GameType | null;
}) => {
    return mutateLocal((canvas) => {
        const group = canvas.groups.find((g) => g.id === data.groupId);
        if (!group) {
            throw new Error("Group not found");
        }

        // The series-leaf invariant is enforced on TYPE writes too, not only on
        // parentage writes (plan A13) — the server refuses this conversion, and
        // a local canvas has no server.
        if (
            childGroupsOf(
                {
                    groups: canvas.groups,
                    drafts: canvas.drafts,
                    annotations: canvas.annotations
                },
                data.groupId
            ).length > 0
        ) {
            throw new Error("Can't convert a group that contains groups");
        }
        if (
            childAnnotationsOf(
                {
                    groups: canvas.groups,
                    drafts: canvas.drafts,
                    annotations: canvas.annotations
                },
                data.groupId
            ).length > 0
        ) {
            throw new Error("Can't convert a group that contains notes");
        }

        const isInitialConversion = group.type === "custom";
        group.name = data.name || group.name;
        group.type = "series";
        group.metadata = mergeLocalGroupMetadata(group.metadata, {
            // undefined leaves whatever the group already had; null clears.
            ...(data.gameType !== undefined ? { gameType: data.gameType } : {}),
            blueTeamName: data.blueTeamName,
            redTeamName: data.redTeamName,
            length: data.length,
            seriesType: data.draftMode,
            origin: "manual",
            disabledChampions: data.disabledChampions,
            draftMode: data.draftMode
        });

        const groupDrafts = canvas.drafts
            .filter((d) => d.group_id === data.groupId)
            .sort(
                (a, b) =>
                    a.positionX - b.positionX ||
                    a.positionY - b.positionY ||
                    a.Draft.id.localeCompare(b.Draft.id)
            );

        for (let i = 0; i < Math.min(groupDrafts.length, data.length); i += 1) {
            groupDrafts[i].Draft.seriesIndex = i;
            if (isInitialConversion) {
                Object.assign(groupDrafts[i].Draft, getManualSeriesGameDefaults(i));
            }
        }
        for (let i = data.length; i < groupDrafts.length; i += 1) {
            groupDrafts[i].Draft.seriesIndex = null;
        }

        const lastDraft = groupDrafts[Math.min(groupDrafts.length, data.length) - 1];
        // Cards are stored relative to their immediate container, so both
        // branches must be container-relative. The empty-group branch used to
        // add group.positionX/Y — a world coordinate. Series rendering ignores
        // these stored values (it lays games out from seriesIndex), so the only
        // symptom was on ungroup, where the Card jumped by the group's position.
        // The seed matches the series layout in helpers.ts.
        const startX = lastDraft ? lastDraft.positionX + 380 : SERIES_PADDING_X;
        const startY = lastDraft
            ? lastDraft.positionY
            : GROUP_BORDER_WIDTH +
              SERIES_HEADER_HEIGHT +
              SERIES_PADDING_Y +
              SERIES_GAME_CONTROLS_HEIGHT;

        for (let i = groupDrafts.length; i < data.length; i += 1) {
            const draftId = crypto.randomUUID();
            canvas.drafts.push({
                draft_id: draftId,
                positionX: startX + (i - groupDrafts.length) * 380,
                positionY: startY,
                group_id: data.groupId,
                source_type: "canvas",
                Draft: {
                    id: draftId,
                    name: `${group.name} - Game ${i + 1}`,
                    picks: Array(20).fill(""),
                    type: "canvas",
                    seriesIndex: i,
                    ...getManualSeriesGameDefaults(i)
                }
            });
        }

        return { canvas, result: { success: true, group } };
    });
};

export const localDeleteGroup = (groupId: string, keepDrafts?: boolean) => {
    return mutateLocal((canvas) => {
        const deleted = canvas.groups.find((g) => g.id === groupId);
        const removedDraftIds = new Set<string>();
        const removedAnnotationIds = new Set<string>();

        if (!keepDrafts) {
            for (const d of canvas.drafts) {
                if (d.group_id === groupId) removedDraftIds.add(d.draft_id);
            }
            canvas.drafts = canvas.drafts.filter((d) => d.group_id !== groupId);
            for (const annotation of canvas.annotations) {
                if (annotation.group_id === groupId) {
                    removedAnnotationIds.add(annotation.id);
                }
            }
            canvas.annotations = canvas.annotations.filter(
                (annotation) => annotation.group_id !== groupId
            );
        } else {
            // A grouped Card's stored position is relative to its container
            // (ADR-0006), so the same numbers read as world once group_id is
            // null — without this rebase every kept Card jumps to near the
            // canvas origin. Same formula the server uses at canvas.js:2038.
            const originX = deleted?.positionX ?? 0;
            const originY = deleted?.positionY ?? 0;
            canvas.drafts = canvas.drafts.map((d) =>
                d.group_id === groupId
                    ? {
                          ...d,
                          positionX: originX + d.positionX,
                          positionY: originY + d.positionY,
                          group_id: null
                      }
                    : d
            );
            for (const annotation of canvas.annotations) {
                if (annotation.group_id !== groupId) continue;
                annotation.positionX += originX;
                annotation.positionY += originY;
                annotation.group_id = null;
            }
        }
        // Promote direct child Groups before the row goes (design §8.2.0): the
        // server does the same UPDATE, and without it a local delete strands a
        // subtree pointing at a row that no longer exists. Coordinates are
        // absolute at every depth (ADR-0006), so a promotion writes no position.
        const promoteTo = deleted?.parent_group_id ?? null;
        for (const child of canvas.groups) {
            if (child.parent_group_id === groupId) child.parent_group_id = promoteTo;
        }
        canvas.groups = canvas.groups.filter((g) => g.id !== groupId);
        // Endpoints anchored to the Group always go; endpoints anchored to the
        // Cards it took with it go on the !keepDrafts path, which used to leave
        // them stranded on drafts that no longer exist.
        canvas.connections = pruneConnectionEndpoints(canvas.connections, (e) =>
            "group_id" in e
                ? e.group_id === groupId
                : "annotation_id" in e
                  ? removedAnnotationIds.has(e.annotation_id)
                  : removedDraftIds.has(e.draft_id)
        );
        return { canvas, result: { success: true } };
    });
};

export const localUpdateDraftGroup = (data: {
    draftId: string;
    group_id: string | null;
    positionX?: number;
    positionY?: number;
}) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === data.draftId);
        if (draft) {
            draft.group_id = data.group_id;
            if (data.positionX !== undefined) draft.positionX = data.positionX;
            if (data.positionY !== undefined) draft.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};

export const localUpdateDraftPositions = (data: {
    positions: DraftPositionUpdate[];
    annotations?: AnnotationPositionUpdate[];
    /**
     * Group rows to move and/or reparent, absolute world (ADR-0006).
     *
     * Unlike the server, this applies each entry verbatim and fans NOTHING out:
     * a local canvas has no concurrency, so the client has already computed
     * every row it wants written and there is no delta to derive. Parentage is
     * validated first, with the server's own wording, because there is no
     * server here to do it.
     */
    groups?: GroupPositionUpdate[];
    group?: {
        id: string;
        width?: number;
        height?: number;
        metadata?: Partial<CanvasGroupMetadata>;
    };
}) => {
    return mutateLocal((canvas) => {
        for (const entry of data.groups ?? []) {
            if (!Object.prototype.hasOwnProperty.call(entry, "parentId")) continue;
            const rejection = parentageRejection(
                {
                    groups: canvas.groups,
                    drafts: canvas.drafts,
                    annotations: canvas.annotations
                },
                entry.id,
                entry.parentId ?? null
            );
            if (rejection) throw new Error(rejection);
        }
        for (const entry of data.groups ?? []) {
            const group = canvas.groups.find((g) => g.id === entry.id);
            if (!group) continue;
            group.positionX = entry.positionX;
            group.positionY = entry.positionY;
            // Key PRESENCE decides, not the value: `parentId: null` means "move
            // to top level" while an absent key means "leave parentage alone".
            if (Object.prototype.hasOwnProperty.call(entry, "parentId")) {
                group.parent_group_id = entry.parentId ?? null;
            }
        }
        for (const p of data.positions) {
            // Matched on draft_id, the Card's placement identity — the field
            // the payload actually carries. Every other lookup in this file
            // takes a `draftId` that really is a Draft.id.
            const draft = canvas.drafts.find((d) => d.draft_id === p.draft_id);
            if (draft) {
                draft.positionX = p.positionX;
                draft.positionY = p.positionY;
                if (p.group_id !== undefined) draft.group_id = p.group_id;
            }
        }
        for (const entry of data.annotations ?? []) {
            const annotation = canvas.annotations.find((item) => item.id === entry.id);
            if (!annotation) continue;
            annotation.positionX = entry.positionX;
            annotation.positionY = entry.positionY;
            if (entry.group_id !== undefined) annotation.group_id = entry.group_id;
        }
        if (data.group) {
            const group = canvas.groups.find((g) => g.id === data.group?.id);
            if (group) {
                if (data.group.width !== undefined) group.width = data.group.width;
                if (data.group.height !== undefined) group.height = data.group.height;
                if (data.group.metadata !== undefined)
                    group.metadata = { ...group.metadata, ...data.group.metadata };
            }
        }
        return { canvas, result: { success: true } };
    });
};

export const localUpdateDraftMetadata = (data: {
    draftId: string;
    winner?: "blue" | "red" | null;
    blueSideTeam?: 1 | 2;
    firstPick?: "blue" | "red";
    team1Name?: string;
    team2Name?: string;
}) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === data.draftId);
        if (draft) {
            if (data.winner !== undefined) {
                draft.Draft.winner = data.winner;
                draft.Draft.completed = data.winner !== null;
            }
            if (data.blueSideTeam !== undefined)
                draft.Draft.blueSideTeam = data.blueSideTeam;
            if (data.firstPick !== undefined) draft.Draft.firstPick = data.firstPick;
            // Empty string means inherit — mirror the server's normalisation.
            if (data.team1Name !== undefined)
                draft.team1Name = data.team1Name.trim() || null;
            if (data.team2Name !== undefined)
                draft.team2Name = data.team2Name.trim() || null;
        }
        return { canvas, result: { success: true } };
    });
};

/**
 * Local mirror of `POST /:canvasId/pools` (design D7): defaults match the
 * server's exactly ("New Pool", empty champions) so a synced local pool
 * looks the same locally as it will once it hits the server. `Pool.version`
 * starts at 0 — `PoolSchema.version` is required, and every local champion
 * op below bumps it, mirroring the row-lock bump `mutatePoolChampions`
 * (backend/services/canvasMutations.js) does on commit.
 */
export const localCreatePool = (data: {
    positionX: number;
    positionY: number;
    name?: string;
    champions?: RolePoolMap;
}) => {
    return mutateLocal((canvas) => {
        const poolId = crypto.randomUUID();
        const placement: CanvasPoolPlacement = {
            id: crypto.randomUUID(),
            canvas_id: "local",
            pool_id: poolId,
            positionX: data.positionX,
            positionY: data.positionY,
            Pool: {
                id: poolId,
                name: data.name?.trim() || "New Pool",
                // Cloned, not the shared module-level object: applyPoolChampionOp
                // always returns a new object on write, but an untouched pool
                // would otherwise hold the SAME EMPTY_ROLE_POOL_MAP reference as
                // every other pool created with no initial champions.
                champions: data.champions ?? { ...EMPTY_ROLE_POOL_MAP },
                version: 0
            }
        };
        canvas.pools.push(placement);
        return { canvas, result: { success: true, placement } };
    });
};

export const localRenamePool = (data: { placementId: string; name: string }) => {
    return mutateLocal((canvas) => {
        const placement = canvas.pools.find((p) => p.id === data.placementId);
        if (placement) {
            placement.Pool.name = data.name;
        }
        return { canvas, result: { success: true } };
    });
};

export const localMovePool = (data: {
    placementId: string;
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const placement = canvas.pools.find((p) => p.id === data.placementId);
        if (placement) {
            placement.positionX = data.positionX;
            placement.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};

export const localDeletePool = (placementId: string) => {
    return mutateLocal((canvas) => {
        canvas.pools = canvas.pools.filter((p) => p.id !== placementId);
        return { canvas, result: { success: true } };
    });
};

/**
 * Applies a single add/remove through the SHARED `applyPoolChampionOp`
 * helper (design D4) — never reimplement the dedupe/no-op semantics here.
 * Version bumps on every applied op, mirroring the server's row-lock bump.
 */
export const localPoolChampionOp = (data: {
    placementId: string;
    op: PoolChampionOp;
}) => {
    return mutateLocal((canvas) => {
        const placement = canvas.pools.find((p) => p.id === data.placementId);
        if (placement) {
            placement.Pool.champions = applyPoolChampionOp(
                placement.Pool.champions,
                data.op
            );
            placement.Pool.version += 1;
        }
        return { canvas, result: { success: true, pool: placement?.Pool } };
    });
};

/**
 * Overwrite-intent only (D4), mirroring `applyPoolReplace` — the local twin
 * of import-from-saved. The overlay's diffs-as-ops commit must never route
 * here.
 */
export const localReplacePool = (data: {
    placementId: string;
    champions: RolePoolMap;
}) => {
    return mutateLocal((canvas) => {
        const placement = canvas.pools.find((p) => p.id === data.placementId);
        if (placement) {
            placement.Pool.champions = data.champions;
            placement.Pool.version += 1;
        }
        return { canvas, result: { success: true, pool: placement?.Pool } };
    });
};
