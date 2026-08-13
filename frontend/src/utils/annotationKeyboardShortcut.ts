export type AnnotationKeyboardShortcut =
    | "start-editing"
    | "stop-editing"
    | "clear-selection"
    | null;

export interface AnnotationKeyboardShortcutInput {
    key: string;
    isConnectionMode: boolean;
    selectedAnnotationId: string | null;
    editingAnnotationId: string | null;
    isInteractiveTarget: boolean;
    isModalOpen: boolean;
}

export const annotationKeyboardShortcut = (
    input: AnnotationKeyboardShortcutInput
): AnnotationKeyboardShortcut => {
    if (input.isConnectionMode || input.isModalOpen) return null;

    if (
        input.key === "Enter" &&
        input.selectedAnnotationId !== null &&
        input.editingAnnotationId === null &&
        !input.isInteractiveTarget
    ) {
        return "start-editing";
    }

    if (input.key !== "Escape") return null;
    if (input.editingAnnotationId !== null) return "stop-editing";
    if (input.selectedAnnotationId !== null) return "clear-selection";
    return null;
};
