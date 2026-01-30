import {
    CanvasDraft,
    Viewport,
    CanvasUser,
    draft,
    Connection,
    VersusDraft,
    CanvasGroup
} from "./types";

export const BASE_URL =
    import.meta.env.VITE_ENVIRONMENT === "production"
        ? `${import.meta.env.VITE_API_URL}/api`
        : "/api";

export const fetchDraft = async (id: string): Promise<any> => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to fetch draft");
    }
    const hold = await res.json();
    return hold;
};

export const postNewDraft = async (data: {
    name: string;
    public: boolean;
    picks?: string[];
    canvas_id?: string;
    positionX?: number;
    positionY?: number;
}) => {
    const res = await fetch(`${BASE_URL}/drafts`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        throw new Error("Failed to create new draft");
    }
    const hold = await res.json();
    return hold;
};

export const fetchDraftList = async () => {
    const res = await fetch(`${BASE_URL}/drafts/dropdown`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to fetch draft list");
    }
    return await res.json();
};

export const fetchDefaultDraft = async (id: string | null): Promise<draft | null> => {
    if (!id || id === "oauth2callback") return null;
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to fetch draft");
    }
    return await res.json();
};

export const editDraft = async (
    id: string,
    data: {
        name?: string;
        description?: string;
        public?: boolean;
        icon?: string;
    }
) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        throw new Error("Failed to edit draft");
    }
    return await res.json();
};

export const deleteDraft = async (id: string) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "DELETE",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to delete draft");
    }
    return await res.json();
};

export const deleteDraftFromCanvas = async (data: { canvas: string; draft: string }) => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvas}/draft/${data.draft}`, {
        method: "DELETE",
        credentials: "include"
    });
    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to fetch draft");
    }
    return await res.json();
};

export const deleteCanvas = async (canvas: string) => {
    const res = await fetch(`${BASE_URL}/canvas/${canvas}`, {
        method: "DELETE",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to delete canvas");
    }
    return await res.json();
};

export const generateShareLink = async (draftId: string) => {
    const res = await fetch(`${BASE_URL}/shares/${draftId}/generate-link`, {
        method: "POST",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to generate share link");
    }
    const { shareLink } = await res.json();
    return shareLink;
};

export const generateVersusShareLink = async (versusDraftId: string) => {
    const res = await fetch(`${BASE_URL}/versus-drafts/${versusDraftId}`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to fetch versus draft");
    }
    const versusDraft = await res.json();
    // Return the full join URL
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
    const res = await fetch(`${BASE_URL}/versus-drafts/${versusDraftId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        throw new Error("Failed to update versus draft");
    }
    return res.json();
};

export const generateCanvasShareLink = async (
    canvasId: string,
    permissions: "view" | "edit" = "view"
) => {
    const res = await fetch(`${BASE_URL}/shares/${canvasId}/generate-canvas-link`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ permissions })
    });
    const { shareLink } = await res.json();
    return shareLink;
};

export type CanvasResposnse = {
    name: string;
    drafts: CanvasDraft[];
    connections: Connection[];
    groups: CanvasGroup[];
    lastViewport: Viewport;
    userPermissions: "view" | "edit" | "admin";
};
export const fetchCanvas = async (canvasId: string): Promise<CanvasResposnse> => {
    const res = await fetch(`${BASE_URL}/canvas/${canvasId}`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        const errorData = await res.json();
        const error = new Error(errorData.error || "Failed to fetch canvas") as Error & {
            status: number;
        };
        error.status = res.status;
        throw error;
    }
    return await res.json();
};

export const generateNewCanvas = async (draftId: string) => {
    const res = await fetch(`${BASE_URL}/canvas/`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ draftId })
    });
    if (!res.ok) {
        throw new Error("Failed to create new canvas");
    }
    return await res.json();
};

export const createCanvas = async (data: {
    name: string;
    description?: string;
    icon?: string;
}): Promise<{
    success: boolean;
    canvas: { id: string; name: string; description?: string; drafts: any[] };
}> => {
    const res = await fetch(`${BASE_URL}/canvas/`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        throw new Error("Failed to create canvas");
    }
    return await res.json();
};

export const updateCanvasName = async (data: {
    canvasId: string;
    name: string;
    description?: string;
    icon?: string;
}) => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/name`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({
            name: data.name,
            description: data.description,
            icon: data.icon
        })
    });

    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update canvas name");
    }

    return res.json();
};

export const fetchDraftCanvases = async (draftId: string) => {
    const res = await fetch(`${BASE_URL}/drafts/${draftId}/canvases`, {
        method: "GET",
        credentials: "include"
    });

    if (!res.ok) {
        throw new Error("Failed to fetch draft canvases");
    }
    return await res.json();
};

export const fetchUserDetails = async () => {
    const res = await fetch(`${BASE_URL}/auth/refresh-token`, {
        method: "GET",
        credentials: "include"
    });

    if (!res.ok) {
        throw new Error("Failed to fetch user details");
    }
    const hold = await res.json();
    return hold.user;
};

export const handleRevoke = async () => {
    fetch(`${BASE_URL}/auth/revoke/`, {
        method: "GET",
        credentials: "include"
    });
};

export const handleLogin = () => {
    const returnTo = window.location.pathname;

    // Just encode the returnTo path directly as state
    const state = btoa(returnTo);

    const googleLoginURL = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${import.meta.env.VITE_GOOGLE_CLIENT_ID}&redirect_uri=${window.location.origin}/oauth2callback&response_type=code&scope=openid%20profile%20email&state=${encodeURIComponent(state)}`;
    window.location.href = googleLoginURL;
};

export const handleGoogleLogin = async (code: string, state: string) => {
    const res = await fetch(`${BASE_URL}/auth/google/callback`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({ code, state })
    });
    if (!res.ok) {
        return null;
    }
    const { user, returnTo } = await res.json();
    return { user, returnTo };
};

export const updateCanvasDraftPosition = async (data: {
    canvasId: string;
    draftId: string;
    positionX: number;
    positionY: number;
}) => {
    const { canvasId, draftId, positionX, positionY } = data;
    const res = await fetch(`${BASE_URL}/canvas/${canvasId}/draft/${draftId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ positionX, positionY })
    });
    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to update position");
    }
    return await res.json();
};

export const updateCanvasViewport = async (data: {
    canvasId: string;
    viewport: { x: number; y: number; zoom: number };
}) => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/viewport`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data.viewport)
    });
    if (!res.ok) {
        throw new Error("Failed to update viewport");
    }
    return await res.json();
};

export const fetchCanvasUsers = async (canvasId: string): Promise<CanvasUser[]> => {
    const res = await fetch(`${BASE_URL}/canvas/${canvasId}/users`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to fetch canvas users");
    }
    const { users } = await res.json();
    return users;
};

export const updateCanvasUserPermission = async (
    canvasId: string,
    userId: string,
    permissions: string
) => {
    const res = await fetch(`${BASE_URL}/canvas/${canvasId}/users/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ permissions })
    });
    if (!res.ok) {
        throw new Error("Failed to update permission");
    }
    return await res.json();
};

export const removeUserFromCanvas = async (canvasId: string, userId: string) => {
    const res = await fetch(`${BASE_URL}/canvas/${canvasId}/users/${userId}`, {
        method: "DELETE",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to remove user");
    }
    return await res.json();
};

export const createConnection = async (data: {
    canvasId: string;
    sourceDraftIds: Array<{ draftId: string; anchorType?: string }>;
    targetDraftIds: Array<{ draftId: string; anchorType?: string }>;
    style?: "solid" | "dashed" | "dotted";
    vertices?: Array<{ id: string; x: number; y: number }>;
}): Promise<{ success: boolean; connection: Connection }> => {
    const response = await fetch(`${BASE_URL}/canvas/${data.canvasId}/connections`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({
            sourceDraftIds: data.sourceDraftIds,
            targetDraftIds: data.targetDraftIds,
            style: data.style,
            vertices: data.vertices
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create connection");
    }

    return response.json();
};

export const createVertex = async (data: {
    canvasId: string;
    connectionId: string;
    x: number;
    y: number;
    insertAfterIndex?: number;
}): Promise<{
    success: boolean;
    vertex: { id: string; x: number; y: number };
    connection: Connection;
}> => {
    const response = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/connections/${data.connectionId}/vertices`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include",
            body: JSON.stringify({
                x: data.x,
                y: data.y,
                insertAfterIndex: data.insertAfterIndex
            })
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create vertex");
    }

    return response.json();
};

export const updateVertex = async (data: {
    canvasId: string;
    connectionId: string;
    vertexId: string;
    x: number;
    y: number;
}): Promise<{ success: boolean; vertex: { id: string; x: number; y: number } }> => {
    const response = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/connections/${data.connectionId}/vertices/${data.vertexId}`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include",
            body: JSON.stringify({
                x: data.x,
                y: data.y
            })
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update vertex");
    }

    return response.json();
};

export const deleteVertex = async (data: {
    canvasId: string;
    connectionId: string;
    vertexId: string;
}): Promise<{ success: boolean; message: string; connection: Connection }> => {
    const response = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/connections/${data.connectionId}/vertices/${data.vertexId}`,
        {
            method: "DELETE",
            credentials: "include"
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete vertex");
    }

    return response.json();
};

export const updateConnection = async (data: {
    canvasId: string;
    connectionId: string;
    addSource?: { draftId: string; anchorType?: string };
    addTarget?: { draftId: string; anchorType?: string };
}): Promise<{ success: boolean; connection: Connection }> => {
    const response = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/connections/${data.connectionId}`,
        {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include",
            body: JSON.stringify({
                addSource: data.addSource,
                addTarget: data.addTarget
            })
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update connection");
    }

    return response.json();
};

export const deleteConnection = async (data: {
    canvasId: string;
    connectionId: string;
}): Promise<{ success: boolean; message: string }> => {
    const response = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/connections/${data.connectionId}`,
        {
            method: "DELETE",
            credentials: "include"
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete connection");
    }

    return response.json();
};

export const fetchRecentActivity = async (
    page: number = 0,
    resourceType?: "draft" | "canvas" | "versus"
) => {
    const params = new URLSearchParams({ page: page.toString() });
    if (resourceType) {
        params.append("resource_type", resourceType);
    }

    const res = await fetch(`${BASE_URL}/activity/recent?${params}`, {
        method: "GET",
        credentials: "include"
    });

    if (!res.ok) {
        throw new Error("Failed to fetch recent activity");
    }

    return await res.json();
};

export const fetchCanvasList = async () => {
    const res = await fetch(`${BASE_URL}/canvas`, {
        method: "GET",
        credentials: "include"
    });

    if (!res.ok) {
        throw new Error("Failed to fetch canvas list");
    }

    return await res.json();
};

export const createDraft = async (data: {
    name: string;
    public: boolean;
    description?: string;
    type?: "standalone" | "canvas" | "versus";
    icon?: string;
}): Promise<{ id: string; name: string; public: boolean; type: string }> => {
    const res = await fetch(`${BASE_URL}/drafts`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            name: data.name,
            public: data.public,
            description: data.description,
            icon: data.icon
        })
    });

    if (!res.ok) {
        throw new Error("Failed to create draft");
    }

    return await res.json();
};

export const importDraftToCanvas = async (data: {
    canvasId: string;
    draftId: string;
    positionX?: number;
    positionY?: number;
}): Promise<{ success: boolean; canvasDraft: CanvasDraft }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/import/draft`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            draftId: data.draftId,
            positionX: data.positionX,
            positionY: data.positionY
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to import draft");
    }
    return await res.json();
};

export const importSeriesToCanvas = async (data: {
    canvasId: string;
    versusDraftId: string;
    positionX?: number;
    positionY?: number;
}): Promise<{ success: boolean; group: any }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/import/series`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            versusDraftId: data.versusDraftId,
            positionX: data.positionX,
            positionY: data.positionY
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to import series");
    }
    return await res.json();
};

export const fetchStandaloneDrafts = async (): Promise<any[]> => {
    const res = await fetch(`${BASE_URL}/drafts?type=standalone`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to fetch standalone drafts");
    }
    return await res.json();
};

export const fetchUserVersusSeries = async (): Promise<VersusDraft[]> => {
    const res = await fetch(`${BASE_URL}/versus-drafts`, {
        method: "GET",
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error("Failed to fetch versus series");
    }
    return await res.json();
};

export const deleteCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
    keepDrafts?: boolean;
}): Promise<{ success: boolean }> => {
    const params = new URLSearchParams();
    if (data.keepDrafts !== undefined) {
        params.append("keepDrafts", String(data.keepDrafts));
    }
    const url = `${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}${params.toString() ? `?${params}` : ""}`;
    const res = await fetch(url, {
        method: "DELETE",
        credentials: "include"
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete group");
    }
    return await res.json();
};

export const updateCanvasGroupPosition = async (data: {
    canvasId: string;
    groupId: string;
    positionX: number;
    positionY: number;
}): Promise<{ success: boolean }> => {
    const res = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}`,
        {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                positionX: data.positionX,
                positionY: data.positionY
            })
        }
    );
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update group position");
    }
    return await res.json();
};

export const createCanvasGroup = async (data: {
    canvasId: string;
    name: string;
    positionX: number;
    positionY: number;
}): Promise<{ success: boolean; group: CanvasGroup }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/group`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: data.name,
            positionX: data.positionX,
            positionY: data.positionY
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create group");
    }
    return await res.json();
};

export const updateCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
    name?: string;
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
}): Promise<{ success: boolean; group: CanvasGroup }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: data.name,
            positionX: data.positionX,
            positionY: data.positionY,
            width: data.width,
            height: data.height
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update group");
    }
    return await res.json();
};

export const updateCanvasDraft = async (data: {
    canvasId: string;
    draftId: string;
    positionX?: number;
    positionY?: number;
    group_id?: string | null;
}): Promise<{ success: boolean }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/draft/${data.draftId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            positionX: data.positionX,
            positionY: data.positionY,
            group_id: data.group_id
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update draft");
    }
    return await res.json();
};

export const fetchCanvasSiblingDrafts = async (draftId: string) => {
    // First get the canvases this draft belongs to
    const canvasRes = await fetch(`${BASE_URL}/drafts/${draftId}/canvases`, {
        method: "GET",
        credentials: "include"
    });

    if (!canvasRes.ok) return { canvas: null, drafts: [] };

    const { canvases } = await canvasRes.json();
    if (!canvases || canvases.length === 0) return { canvas: null, drafts: [] };

    // Use the first canvas
    const canvas = canvases[0];

    // Fetch the canvas details to get all its drafts
    const detailRes = await fetch(`${BASE_URL}/canvas/${canvas.id}`, {
        method: "GET",
        credentials: "include"
    });

    if (!detailRes.ok) return { canvas, drafts: [] };

    const canvasData = await detailRes.json();
    return {
        canvas: { id: canvas.id, name: canvas.name },
        drafts: canvasData.drafts || []
    };
};
