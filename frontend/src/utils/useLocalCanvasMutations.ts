import { CanvasDraft, Connection, CanvasGroup, Viewport } from "./types";
import { getLocalCanvas, saveLocalCanvas, LocalCanvas } from "./localCanvasStore";

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

export const localNewDraft = (data: {
    name: string;
    picks: string[];
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const draftId = crypto.randomUUID();
        const newDraft: CanvasDraft = {
            positionX: data.positionX,
            positionY: data.positionY,
            group_id: null,
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

export const localCopyDraft = (draftId: string) => {
    return mutateLocal((canvas) => {
        const originalDraft = canvas.drafts.find((d) => d.Draft.id === draftId);
        if (!originalDraft) {
            throw new Error("Draft not found");
        }

        const newDraftId = crypto.randomUUID();
        const newDraft: CanvasDraft = {
            positionX: originalDraft.positionX + COPY_OFFSET,
            positionY: originalDraft.positionY + COPY_OFFSET,
            group_id: null,
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
                          anchor_type: (e.anchorType ?? "bottom") as any
                      }
                    : {
                          draft_id: e.draftId!,
                          anchor_type: (e.anchorType ?? "bottom") as any
                      }
            ),
            target_draft_ids: data.targetDraftIds.map((e) =>
                e.groupId
                    ? {
                          type: "group" as const,
                          group_id: e.groupId,
                          anchor_type: (e.anchorType ?? "top") as any
                      }
                    : {
                          draft_id: e.draftId!,
                          anchor_type: (e.anchorType ?? "top") as any
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
                          anchor_type: (data.addSource.anchorType ?? "bottom") as any
                      }
                    : {
                          draft_id: data.addSource.draftId!,
                          anchor_type: (data.addSource.anchorType ?? "bottom") as any
                      };
                conn.source_draft_ids.push(endpoint);
            }
            if (data.addTarget) {
                const endpoint = data.addTarget.groupId
                    ? {
                          type: "group" as const,
                          group_id: data.addTarget.groupId,
                          anchor_type: (data.addTarget.anchorType ?? "top") as any
                      }
                    : {
                          draft_id: data.addTarget.draftId!,
                          anchor_type: (data.addTarget.anchorType ?? "top") as any
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

export const localCreateGroup = (data: { positionX: number; positionY: number }) => {
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
        const group: CanvasGroup = {
            id: crypto.randomUUID(),
            canvas_id: "local",
            name,
            type: "custom",
            positionX: data.positionX,
            positionY: data.positionY,
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

export const localUpdateGroup = (data: {
    groupId: string;
    name?: string;
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
}) => {
    return mutateLocal((canvas) => {
        const group = canvas.groups.find((g) => g.id === data.groupId);
        if (group) {
            if (data.name !== undefined) group.name = data.name;
            if (data.positionX !== undefined) group.positionX = data.positionX;
            if (data.positionY !== undefined) group.positionY = data.positionY;
            if (data.width !== undefined) group.width = data.width;
            if (data.height !== undefined) group.height = data.height;
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
