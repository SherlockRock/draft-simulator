import { createContext, useContext, Setter, Resource, Accessor } from "solid-js";

// Canvas context type definition - shared between CanvasWorkflow and consumers
export type CanvasContextType = {
    canvas: Resource<any>;
    mutateCanvas: Setter<any>;
    refetchCanvas: () => void;
    canvasList: Resource<any>;
    mutateCanvasList: Setter<any>;
    layoutToggle: Accessor<boolean>;
    setLayoutToggle: Setter<boolean>;
    createDraftCallback: Accessor<(() => void) | null>;
    setCreateDraftCallback: Setter<(() => void) | null>;
    navigateToDraftCallback: Accessor<
        ((positionX: number, positionY: number) => void) | null
    >;
    setNavigateToDraftCallback: Setter<
        ((positionX: number, positionY: number) => void) | null
    >;
    importCallback: Accessor<(() => void) | null>;
    setImportCallback: Setter<(() => void) | null>;
    createGroupCallback: Accessor<
        ((positionX: number, positionY: number) => void) | null
    >;
    setCreateGroupCallback: Setter<
        ((positionX: number, positionY: number) => void) | null
    >;
    refetchCanvasList: () => void;
    setEditingGroupIdCallback: Accessor<((id: string | null) => void) | null>;
    setSetEditingGroupIdCallback: Setter<((id: string | null) => void) | null>;
    deleteGroupCallback: Accessor<((groupId: string) => void) | null>;
    setDeleteGroupCallback: Setter<((groupId: string) => void) | null>;
    setEditingDraftIdCallback: Accessor<((id: string | null) => void) | null>;
    setSetEditingDraftIdCallback: Setter<((id: string | null) => void) | null>;
};

export const CanvasContext = createContext<CanvasContextType>();

export const useCanvasContext = () => {
    const context = useContext(CanvasContext);
    if (!context) {
        throw new Error("useCanvasContext must be used within CanvasWorkflow");
    }
    return context;
};
