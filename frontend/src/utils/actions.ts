import { z } from "zod";
import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from "./apiClient";
import { track } from "./analytics";
import {
    DraftSchema,
    CanvasDraftSchema,
    CanvasGroupSchema,
    ConnectionSchema,
    VertexSchema,
    CanvasUserSchema,
    VersusDraftSchema,
    VersusDraftListItemSchema,
    CanvasResponseSchema,
    ShareLinkResponseSchema,
    UserDetailsSchema,
    CanvasListItemSchema,
    ActivityResponseSchema,
    SuccessSchema,
    ImportSeriesResponseSchema,
    UpdateCanvasNameResponseSchema
} from "./schemas";

// Re-export types for backward compatibility
export type { CanvasResponse as CanvasResposnse } from "./schemas";

export const BASE_URL =
    import.meta.env.VITE_ENVIRONMENT === "production"
        ? `${import.meta.env.VITE_API_URL}/api`
        : "/api";

// =============================================================================
// Draft Operations
// =============================================================================

export const postNewDraft = async (data: {
    name: string;
    public: boolean;
    picks?: string[];
    canvas_id?: string;
    positionX?: number;
    positionY?: number;
}) => {
    const result = await apiPost("/drafts", data, DraftSchema);
    track("draft_created");
    return result;
};

export const fetchDefaultDraft = async (id: string | null, canvasId?: string | null) => {
    if (!id || id === "oauth2callback") return null;
    const params = canvasId ? `?canvas_id=${canvasId}` : "";
    return apiGet(`/drafts/${id}${params}`, DraftSchema.nullable());
};

export const editDraft = async (
    id: string,
    data: {
        name?: string;
        description?: string;
        public?: boolean;
        icon?: string;
    },
    canvasId?: string
) => {
    const params = canvasId ? `?canvas_id=${canvasId}` : "";
    return apiPut(`/drafts/${id}${params}`, data, DraftSchema);
};

export const deleteDraftFromCanvas = async (data: { canvas: string; draft: string }) => {
    return apiDelete(`/canvas/${data.canvas}/draft/${data.draft}`, SuccessSchema);
};

export const copyDraftInCanvas = async (data: { canvasId: string; draftId: string }) => {
    return apiPost(
        `/canvas/${data.canvasId}/draft/${data.draftId}/copy`,
        {},
        z.object({ success: z.boolean(), canvasDraft: CanvasDraftSchema })
    );
};

// =============================================================================
// Canvas Operations
// =============================================================================

export const fetchCanvas = async (canvasId: string) => {
    return apiGet(`/canvas/${canvasId}`, CanvasResponseSchema);
};

export const generateNewCanvas = async (draftId: string) => {
    return apiPost("/canvas/", { draftId }, CanvasResponseSchema);
};

export const createCanvas = async (data: {
    name: string;
    description?: string;
    icon?: string;
}) => {
    const result = await apiPost(
        "/canvas/",
        data,
        z.object({
            success: z.boolean(),
            canvas: z.object({
                id: z.string(),
                name: z.string(),
                description: z.string().optional(),
                drafts: z.array(z.unknown())
            })
        })
    );
    track("canvas_created");
    return result;
};

export const updateCanvasName = async (data: {
    canvasId: string;
    name: string;
    description?: string;
    icon?: string;
}) => {
    const result = await apiPatch(
        `/canvas/${data.canvasId}/name`,
        {
            name: data.name,
            description: data.description,
            icon: data.icon
        },
        UpdateCanvasNameResponseSchema
    );
    // Return shape expected by callers
    return { name: result.canvas.name, id: result.canvas.id };
};

export const fetchCanvasList = async () => {
    return apiGet("/canvas", z.array(CanvasListItemSchema));
};

export const updateCanvasViewport = async (data: {
    canvasId: string;
    viewport: { x: number; y: number; zoom: number };
}) => {
    return apiPatch(`/canvas/${data.canvasId}/viewport`, data.viewport, SuccessSchema);
};

export const deleteCanvas = async (canvasId: string) => {
    return apiDelete(`/canvas/${canvasId}`, SuccessSchema);
};

export const updateCanvasDraftPosition = async (data: {
    canvasId: string;
    draftId: string;
    positionX: number;
    positionY: number;
}) => {
    const { canvasId, draftId, positionX, positionY } = data;
    return apiPut(
        `/canvas/${canvasId}/draft/${draftId}`,
        { positionX, positionY },
        SuccessSchema
    );
};

export const updateCanvasDraft = async (data: {
    canvasId: string;
    draftId: string;
    positionX?: number;
    positionY?: number;
    group_id?: string | null;
}) => {
    return apiPut(
        `/canvas/${data.canvasId}/draft/${data.draftId}`,
        {
            positionX: data.positionX,
            positionY: data.positionY,
            group_id: data.group_id
        },
        SuccessSchema
    );
};

export const importDraftToCanvas = async (data: {
    canvasId: string;
    draftId: string;
    positionX?: number;
    positionY?: number;
}) => {
    return apiPost(
        `/canvas/${data.canvasId}/import/draft`,
        {
            draftId: data.draftId,
            positionX: data.positionX,
            positionY: data.positionY
        },
        z.object({ success: z.boolean(), canvasDraft: CanvasDraftSchema })
    );
};

export const importSeriesToCanvas = async (data: {
    canvasId: string;
    versusDraftId: string;
    positionX?: number;
    positionY?: number;
}) => {
    return apiPost(
        `/canvas/${data.canvasId}/import/series`,
        {
            versusDraftId: data.versusDraftId,
            positionX: data.positionX,
            positionY: data.positionY
        },
        ImportSeriesResponseSchema
    );
};

// =============================================================================
// Canvas Sharing/Users
// =============================================================================

export const generateShareLink = async (draftId: string) => {
    const result = await apiPost(
        `/shares/${draftId}/generate-link`,
        {},
        ShareLinkResponseSchema
    );
    track("draft_shared");
    return result.shareLink;
};

export const generateCanvasShareLink = async (
    canvasId: string,
    permissions: "view" | "edit" = "view"
) => {
    const result = await apiPost(
        `/shares/${canvasId}/generate-canvas-link`,
        { permissions },
        ShareLinkResponseSchema
    );
    track("canvas_shared");
    return result.shareLink;
};

export const fetchCanvasUsers = async (canvasId: string) => {
    const result = await apiGet(
        `/canvas/${canvasId}/users`,
        z.object({ users: z.array(CanvasUserSchema) })
    );
    return result.users;
};

export const updateCanvasUserPermission = async (
    canvasId: string,
    userId: string,
    permissions: string
) => {
    return apiPut(`/canvas/${canvasId}/users/${userId}`, { permissions }, SuccessSchema);
};

export const removeUserFromCanvas = async (canvasId: string, userId: string) => {
    return apiDelete(`/canvas/${canvasId}/users/${userId}`, SuccessSchema);
};

// =============================================================================
// Connections/Vertices
// =============================================================================

type ConnectionEndpointInput =
    | { draftId: string; anchorType?: string }
    | { groupId: string; anchorType?: string };

export const createConnection = async (data: {
    canvasId: string;
    sourceDraftIds: Array<ConnectionEndpointInput>;
    targetDraftIds: Array<ConnectionEndpointInput>;
    style?: "solid" | "dashed" | "dotted";
    vertices?: Array<{ id: string; x: number; y: number }>;
}) => {
    return apiPost(
        `/canvas/${data.canvasId}/connections`,
        {
            sourceDraftIds: data.sourceDraftIds,
            targetDraftIds: data.targetDraftIds,
            style: data.style,
            vertices: data.vertices
        },
        z.object({ success: z.boolean(), connection: ConnectionSchema })
    );
};

export const updateConnection = async (data: {
    canvasId: string;
    connectionId: string;
    addSource?: ConnectionEndpointInput;
    addTarget?: ConnectionEndpointInput;
}) => {
    return apiPatch(
        `/canvas/${data.canvasId}/connections/${data.connectionId}`,
        {
            addSource: data.addSource,
            addTarget: data.addTarget
        },
        z.object({ success: z.boolean(), connection: ConnectionSchema })
    );
};

export const deleteConnection = async (data: {
    canvasId: string;
    connectionId: string;
}) => {
    return apiDelete(
        `/canvas/${data.canvasId}/connections/${data.connectionId}`,
        z.object({ success: z.boolean(), message: z.string() })
    );
};

export const createVertex = async (data: {
    canvasId: string;
    connectionId: string;
    x: number;
    y: number;
    insertAfterIndex?: number;
}) => {
    return apiPost(
        `/canvas/${data.canvasId}/connections/${data.connectionId}/vertices`,
        {
            x: data.x,
            y: data.y,
            insertAfterIndex: data.insertAfterIndex
        },
        z.object({
            success: z.boolean(),
            vertex: VertexSchema,
            connection: ConnectionSchema
        })
    );
};

export const updateVertex = async (data: {
    canvasId: string;
    connectionId: string;
    vertexId: string;
    x: number;
    y: number;
}) => {
    return apiPut(
        `/canvas/${data.canvasId}/connections/${data.connectionId}/vertices/${data.vertexId}`,
        { x: data.x, y: data.y },
        z.object({ success: z.boolean(), vertex: VertexSchema })
    );
};

export const deleteVertex = async (data: {
    canvasId: string;
    connectionId: string;
    vertexId: string;
}) => {
    return apiDelete(
        `/canvas/${data.canvasId}/connections/${data.connectionId}/vertices/${data.vertexId}`,
        z.object({
            success: z.boolean(),
            message: z.string(),
            connection: ConnectionSchema
        })
    );
};

// =============================================================================
// Groups
// =============================================================================

export const createCanvasGroup = async (data: {
    canvasId: string;
    name?: string;
    positionX: number;
    positionY: number;
}) => {
    return apiPost(
        `/canvas/${data.canvasId}/group`,
        {
            name: data.name,
            positionX: data.positionX,
            positionY: data.positionY
        },
        z.object({ success: z.boolean(), group: CanvasGroupSchema })
    );
};

export const updateCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
    name?: string;
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
}) => {
    return apiPut(
        `/canvas/${data.canvasId}/group/${data.groupId}`,
        {
            name: data.name,
            positionX: data.positionX,
            positionY: data.positionY,
            width: data.width,
            height: data.height
        },
        z.object({ success: z.boolean(), group: CanvasGroupSchema })
    );
};

export const updateCanvasGroupPosition = async (data: {
    canvasId: string;
    groupId: string;
    positionX: number;
    positionY: number;
}) => {
    return apiPut(
        `/canvas/${data.canvasId}/group/${data.groupId}`,
        {
            positionX: data.positionX,
            positionY: data.positionY
        },
        SuccessSchema
    );
};

export const deleteCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
    keepDrafts?: boolean;
}) => {
    const params = data.keepDrafts !== undefined ? `?keepDrafts=${data.keepDrafts}` : "";
    return apiDelete(
        `/canvas/${data.canvasId}/group/${data.groupId}${params}`,
        SuccessSchema
    );
};

// =============================================================================
// Versus Operations
// =============================================================================

export const generateVersusShareLink = async (versusDraftId: string) => {
    const versusDraft = await apiGet(
        `/versus-drafts/${versusDraftId}`,
        VersusDraftSchema
    );
    return `${window.location.origin}/versus/join/${versusDraft.shareLink}`;
};

export const editVersusDraft = async (
    versusDraftId: string,
    data: {
        name?: string;
        description?: string;
        blueTeamName?: string;
        redTeamName?: string;
        competitive?: boolean;
        icon?: string;
        type?: string;
        length?: number;
    }
) => {
    return apiPut(`/versus-drafts/${versusDraftId}`, data, VersusDraftSchema);
};

export const fetchUserVersusSeries = async () => {
    return apiGet("/versus-drafts", z.array(VersusDraftListItemSchema));
};

// =============================================================================
// User/Auth
// =============================================================================

export const fetchUserDetails = async () => {
    const result = await apiGet(
        "/auth/refresh-token",
        z.object({ user: UserDetailsSchema })
    );
    return result.user;
};

export const handleRevoke = async () => {
    // Fire and forget - no response validation needed
    fetch(`${BASE_URL}/auth/revoke/`, {
        method: "GET",
        credentials: "include"
    });
};

export const handleLogin = () => {
    const returnTo = window.location.pathname;
    const state = btoa(returnTo);
    const googleLoginURL = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${import.meta.env.VITE_GOOGLE_CLIENT_ID}&redirect_uri=${window.location.origin}/oauth2callback&response_type=code&scope=openid%20profile%20email&state=${encodeURIComponent(state)}`;
    window.location.href = googleLoginURL;
};

export const handleGoogleLogin = async (code: string, state: string) => {
    try {
        const result = await apiPost(
            "/auth/google/callback",
            { code, state },
            z.object({
                user: UserDetailsSchema,
                returnTo: z.string().optional(),
                isNewUser: z.boolean().optional()
            })
        );
        return { user: result.user, returnTo: result.returnTo, isNewUser: result.isNewUser };
    } catch {
        return null;
    }
};

export const exportUserData = async () => {
    return apiGet(
        "/users/me/export",
        z.object({
            exportedAt: z.string(),
            user: z.object({
                name: z.string(),
                email: z.string(),
                picture: z.string(),
                createdAt: z.string()
            }),
            canvases: z.array(z.unknown()),
            versusSeries: z.array(z.unknown())
        })
    );
};

export const deleteUserAccount = async (confirmEmail: string) => {
    return apiDelete("/users/me", SuccessSchema, { confirmEmail });
};

// =============================================================================
// Other
// =============================================================================

export const fetchRecentActivity = async (
    page: number = 0,
    resourceType?: "draft" | "canvas" | "versus",
    search?: string,
    sort?: "recent" | "oldest" | "name_asc" | "name_desc"
) => {
    const params = new URLSearchParams({ page: page.toString() });
    if (resourceType) {
        params.append("resource_type", resourceType);
    }
    if (search) {
        params.append("search", search);
    }
    if (sort) {
        params.append("sort", sort);
    }
    return apiGet(`/activity/recent?${params}`, ActivityResponseSchema);
};

export const fetchStandaloneDrafts = async () => {
    return apiGet("/drafts?type=standalone", z.array(DraftSchema));
};
