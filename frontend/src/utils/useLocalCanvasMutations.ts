import { CanvasDraft, Connection, CanvasGroup, Viewport, AnchorType } from "./schemas";
import { getLocalCanvas, saveLocalCanvas, LocalCanvas } from "./localCanvasStore";
import type { CardLayout } from "./canvasCardLayout";
import type {
    CanvasGroupMetadata,
    CanvasGroupMetadataUpdate,
    DraftPositionUpdate,
    GameType,
    GroupPositionUpdate
} from "@draft-sim/shared-types";
import { getManualSeriesGameDefaults } from "./manualSeriesDefaults";
import { childGroupsOf } from "./canvasTree";
import { parentageRejection } from "./groupParentage";
import { SERIES_HEADER_HEIGHT, SERIES_PADDING } from "./helpers";

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
        // Also remove connections referencing this draft
        canvas.connections = canvas.connections.filter((c) => {
            const srcRefs = c.source_draft_ids.some(
                (e) => "draft_id" in e && e.draft_id === draftId
            );
            const tgtRefs = c.target_draft_ids.some(
                (e) => "draft_id" in e && e.draft_id === draftId
            );
            return !srcRefs && !tgtRefs;
        });
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

export const localUpdateViewport = (viewport: Viewport) => {
    return mutateLocal((canvas) => {
        canvas.viewport = viewport;
        return { canvas, result: { success: true } };
    });
};

export const localCreateConnection = (data: {
    sourceDraftIds: Array<{ draftId?: string; groupId?: string; anchorType?: string }>;
    targetDraftIds: Array<{ draftId?: string; groupId?: string; anchorType?: string }>;
    style?: "solid" | "dashed" | "dotted";
    vertices?: Array<{ id: string; x: number; y: number }>;
}) => {
    return mutateLocal((canvas) => {
        const connectionId = crypto.randomUUID();
        const connection: Connection = {
            id: connectionId,
            canvas_id: "local",
            source_draft_ids: data.sourceDraftIds.map((e) =>
                e.groupId
                    ? {
                          type: "group" as const,
                          group_id: e.groupId,
                          anchor_type: toAnchorType(e.anchorType, "bottom")
                      }
                    : {
                          draft_id: e.draftId!,
                          anchor_type: toAnchorType(e.anchorType, "bottom")
                      }
            ),
            target_draft_ids: data.targetDraftIds.map((e) =>
                e.groupId
                    ? {
                          type: "group" as const,
                          group_id: e.groupId,
                          anchor_type: toAnchorType(e.anchorType, "top")
                      }
                    : {
                          draft_id: e.draftId!,
                          anchor_type: toAnchorType(e.anchorType, "top")
                      }
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
    addSource?: { draftId?: string; groupId?: string; anchorType?: string };
    addTarget?: { draftId?: string; groupId?: string; anchorType?: string };
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            if (data.addSource) {
                const endpoint = data.addSource.groupId
                    ? {
                          type: "group" as const,
                          group_id: data.addSource.groupId,
                          anchor_type: toAnchorType(data.addSource.anchorType, "bottom")
                      }
                    : {
                          draft_id: data.addSource.draftId!,
                          anchor_type: toAnchorType(data.addSource.anchorType, "bottom")
                      };
                conn.source_draft_ids.push(endpoint);
            }
            if (data.addTarget) {
                const endpoint = data.addTarget.groupId
                    ? {
                          type: "group" as const,
                          group_id: data.addTarget.groupId,
                          anchor_type: toAnchorType(data.addTarget.anchorType, "top")
                      }
                    : {
                          draft_id: data.addTarget.draftId!,
                          anchor_type: toAnchorType(data.addTarget.anchorType, "top")
                      };
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
}) => {
    return mutateLocal((canvas) => {
        const existingNames = new Set(canvas.groups.map((g) => g.name));
        let name = "New Group";
        if (existingNames.has(name)) {
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
                { groups: canvas.groups, drafts: canvas.drafts },
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
            metadata: {}
        };
        canvas.groups.push(group);
        return { canvas, result: { success: true, group } };
    });
};

export const localUpdateGroupPosition = (data: {
    groupId: string;
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const group = canvas.groups.find((g) => g.id === data.groupId);
        if (group) {
            group.positionX = data.positionX;
            group.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};

/**
 * Local mirror of the backend's clear protocol (D3): an inbound
 * `gameType: null` deletes the key rather than storing a null, so local
 * metadata keeps the same enum-or-absent shape the read schema expects.
 */
const mergeLocalGroupMetadata = (
    stored: CanvasGroupMetadata,
    incoming: CanvasGroupMetadataUpdate
): CanvasGroupMetadata => {
    const { gameType, ...rest } = incoming;
    const merged: CanvasGroupMetadata = { ...stored, ...rest };
    if (gameType === null) delete merged.gameType;
    else if (gameType !== undefined) merged.gameType = gameType;
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
            childGroupsOf({ groups: canvas.groups, drafts: canvas.drafts }, data.groupId)
                .length > 0
        ) {
            throw new Error("Can't convert a group that contains groups");
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
        const startX = lastDraft ? lastDraft.positionX + 380 : SERIES_PADDING;
        const startY = lastDraft
            ? lastDraft.positionY
            : SERIES_HEADER_HEIGHT + SERIES_PADDING;

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
        if (!keepDrafts) {
            canvas.drafts = canvas.drafts.filter((d) => d.group_id !== groupId);
        } else {
            canvas.drafts = canvas.drafts.map((d) =>
                d.group_id === groupId ? { ...d, group_id: null } : d
            );
        }
        // Promote direct child Groups before the row goes (design §8.2.0): the
        // server does the same UPDATE, and without it a local delete strands a
        // subtree pointing at a row that no longer exists. Coordinates are
        // absolute at every depth (ADR-0006), so a promotion writes no position.
        const deleted = canvas.groups.find((g) => g.id === groupId);
        const promoteTo = deleted?.parent_group_id ?? null;
        for (const child of canvas.groups) {
            if (child.parent_group_id === groupId) child.parent_group_id = promoteTo;
        }
        canvas.groups = canvas.groups.filter((g) => g.id !== groupId);
        // Remove connections referencing this group
        canvas.connections = canvas.connections.filter((c) => {
            const srcRefs = c.source_draft_ids.some(
                (e) => "group_id" in e && e.group_id === groupId
            );
            const tgtRefs = c.target_draft_ids.some(
                (e) => "group_id" in e && e.group_id === groupId
            );
            return !srcRefs && !tgtRefs;
        });
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
                { groups: canvas.groups, drafts: canvas.drafts },
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
