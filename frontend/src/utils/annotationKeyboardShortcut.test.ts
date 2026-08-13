import { describe, expect, it } from "vitest";
import { annotationKeyboardShortcut } from "./annotationKeyboardShortcut";

const input = (key: string, isModalOpen: boolean) => ({
    key,
    isConnectionMode: false,
    selectedAnnotationId: "note-1",
    editingAnnotationId: null,
    isInteractiveTarget: false,
    isModalOpen
});

describe("annotationKeyboardShortcut", () => {
    it("starts editing a selected note on Enter when no modal is open", () => {
        expect(annotationKeyboardShortcut(input("Enter", false))).toBe("start-editing");
    });

    it("leaves Enter to an open modal", () => {
        expect(annotationKeyboardShortcut(input("Enter", true))).toBeNull();
    });

    it("clears a selected note on Escape when no modal is open", () => {
        expect(annotationKeyboardShortcut(input("Escape", false))).toBe(
            "clear-selection"
        );
    });

    it("leaves Escape to an open modal", () => {
        expect(annotationKeyboardShortcut(input("Escape", true))).toBeNull();
    });
});
