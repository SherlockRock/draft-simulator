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
