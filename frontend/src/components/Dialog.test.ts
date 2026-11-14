// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { shouldDialogConfirmOnEnter } from "./Dialog";

describe("Dialog Enter confirmation target", () => {
    it.each(["Cancel", "Close dialog", "Add league"])(
        "leaves Enter on %s to the focused button",
        (label) => {
            const button = document.createElement("button");
            button.textContent = label;
            expect(shouldDialogConfirmOnEnter(button, true)).toBe(false);
        }
    );

    it("leaves Enter on a close button's icon to its button", () => {
        const button = document.createElement("button");
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        button.append(icon);
        expect(shouldDialogConfirmOnEnter(icon, true)).toBe(false);
    });

    it.each(["button", "submit", "reset", "checkbox", "radio", "range"])(
        "preserves native Enter for an input of type %s",
        (type) => {
            const input = document.createElement("input");
            input.type = type;
            expect(shouldDialogConfirmOnEnter(input, true)).toBe(false);
        }
    );

    it("preserves native Enter for a region select", () => {
        expect(shouldDialogConfirmOnEnter(document.createElement("select"), true)).toBe(
            false
        );
    });

    it("preserves native Enter for a link even with a custom confirmation predicate", () => {
        const link = document.createElement("a");
        link.href = "/teams";
        expect(shouldDialogConfirmOnEnter(link, true, () => true)).toBe(false);
    });

    it("preserves native Enter for a custom button", () => {
        const button = document.createElement("div");
        button.setAttribute("role", "button");
        expect(shouldDialogConfirmOnEnter(button, true)).toBe(false);
    });

    it.each(["text", "url", "search", "email", "number"])(
        "keeps opted-in Enter confirmation from a %s input",
        (type) => {
            const input = document.createElement("input");
            input.type = type;
            expect(shouldDialogConfirmOnEnter(input)).toBe(false);
            expect(shouldDialogConfirmOnEnter(input, true)).toBe(true);
            expect(
                shouldDialogConfirmOnEnter(
                    input,
                    false,
                    (target) => target instanceof HTMLInputElement
                )
            ).toBe(true);
        }
    );

    it("keeps textarea opt-in behaviour", () => {
        const textarea = document.createElement("textarea");
        expect(shouldDialogConfirmOnEnter(textarea)).toBe(false);
        expect(shouldDialogConfirmOnEnter(textarea, true)).toBe(true);
        expect(shouldDialogConfirmOnEnter(textarea, false, () => false)).toBe(false);
    });

    it("keeps Enter confirmation from noninteractive dialog content", () => {
        expect(shouldDialogConfirmOnEnter(document.createElement("div"))).toBe(true);
    });
});
