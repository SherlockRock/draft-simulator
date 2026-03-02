import { createContext, useContext, Setter, Resource, Accessor, JSX } from "solid-js";
import type { CanvasResponse, CanvasListItem } from "@draft-sim/shared-types";

// Canvas context type definition - shared between CanvasWorkflow and consumers
type CanvasContextType = {
    canvas: Resource<CanvasResponse | undefined>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutateCanvas: Setter<any>;
    refetchCanvas: () => void;
    canvasList: Resource<CanvasListItem[] | undefined>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Settings/share controls (managed by workflow, used by canvas sidebar)
    openSettings: () => void;
    toggleShare: () => void;
    closeSharePopper: () => void;
    setSharePopperRef: (el: HTMLDivElement) => void;
    setShareButtonRef: (el: HTMLDivElement) => void;
    sharePopperContent: Accessor<JSX.Element | null>;
};

export const CanvasContext = createContext<CanvasContextType>();

export const useCanvasContext = () => {
    const context = useContext(CanvasContext);
    if (!context) {
        throw new Error("useCanvasContext must be used within CanvasWorkflow");
    }
    return context;
};
