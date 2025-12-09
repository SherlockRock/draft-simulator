export type CanvasDraft = {
    positionX: number;
    positionY: number;
    Draft: {
        name: string;
        id: string;
        picks: string[];
    };
};

export type Viewport = {
    x: number;
    y: number;
    zoom: number;
};

export type draft = {
    id: string;
    name: string;
    public: boolean;
    picks: string[];
    owner_id: string;
};

export type CanvasUser = {
    id: string;
    name: string;
    email: string;
    picture: string;
    permissions: "view" | "edit" | "admin";
    lastAccessedAt: string;
};

export type AnchorType = "top" | "bottom" | "left" | "right";

export type AnchorPoint = {
    type: AnchorType;
};

export type AnchorPosition = {
    x: number;
    y: number;
};

export type ConnectionEndpoint = {
    draft_id: string;
    anchor_type: AnchorType;
};

export type Vertex = {
    id: string;
    x: number; // World coordinates
    y: number; // World coordinates
};

export type Connection = {
    id: string;
    canvas_id: string;
    source_draft_ids: ConnectionEndpoint[];
    target_draft_ids: ConnectionEndpoint[];
    vertices: Vertex[];
    style: "solid" | "dashed" | "dotted";
};

export type ContextMenuAction = {
    label: string;
    action: () => void;
    destructive?: boolean;
};

export type ContextMenuPosition = {
    x: number; // Screen coordinates
    y: number; // Screen coordinates
};
