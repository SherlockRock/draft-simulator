// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import {
    For,
    batch,
    createComponent,
    createSignal,
    type ComponentProps,
    type JSX
} from "solid-js";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";
import { CanvasAnnotation, annotationRenderTop } from "./CanvasAnnotation";

afterEach(cleanup);

describe("annotation editor", () => {
    const setup = (initiallyEditing = false, attachAfterRender = false) => {
        const [notes, setNotes] = createSignal<ComponentProps<typeof CanvasAnnotation>[]>(
            []
        );
        const [editingId, setEditingId] = createSignal<string | null>(
            initiallyEditing ? "note-1" : null
        );
        const onCommitText = vi.fn();
        const props: ComponentProps<typeof CanvasAnnotation> = {
            annotation: {
                id: "note-1",
                canvas_id: "local",
                group_id: null,
                positionX: 0,
                positionY: 0,
                width: 380,
                height: 200,
                text: "",
                color: "slate",
                fontSize: "md",
                manualWidth: null,
                manualHeight: null
            },
            isGrouped: false,
            zoom: () => 1,
            canEdit: () => true,
            isConnectionMode: false,
            onAnchorClick: vi.fn(),
            connectionSource: () => null,
            sourceAnchor: () => null,
            snappedSize: () => null,
            isSelected: () => true,
            editingAnnotationId: editingId,
            lockedByName: () => null,
            onBlockedByLock: vi.fn(),
            onEditingComplete: () => setEditingId(null),
            onStartEditing: setEditingId,
            onMouseDown: vi.fn(),
            isTextCollapsed: () => true,
            onOpenInsertPicker: vi.fn(),
            onCloseInsertPicker: vi.fn(),
            insertPickerOpenFor: () => null,
            insertedChampion: () => null,
            onCommitText,
            onResize: vi.fn(),
            onResizeEnd: vi.fn()
        };
        const container = document.createElement("div");
        if (!attachAfterRender) document.body.append(container);
        const view = render(
            () =>
                createComponent(
                    For<ComponentProps<typeof CanvasAnnotation>[], JSX.Element>,
                    {
                        get each() {
                            return notes();
                        },
                        children: (note) => createComponent(CanvasAnnotation, note)
                    }
                ),
            { container }
        );
        batch(() => {
            setNotes([props]);
            if (initiallyEditing) setEditingId("note-1");
        });
        if (attachAfterRender) document.body.append(container);
        return { ...view, setEditingId, onCommitText };
    };

    it.each([false, true])(
        "focuses a new note so typing works immediately (editing at mount: %s)",
        async (initiallyEditing) => {
            const view = setup(initiallyEditing);
            // Canvas inserts the row, then sets editingAnnotationId. Also cover
            // batching both writes, so the note can mount already editing.
            view.setEditingId("note-1");
            await Promise.resolve();
            const editor = view.getByRole("textbox") as HTMLTextAreaElement;
            expect(document.activeElement).toBe(editor);
            fireEvent.input(document.activeElement!, { target: { value: "New note" } });
            fireEvent.keyDown(editor, { key: "Escape" });
            expect(view.onCommitText).toHaveBeenCalledWith("note-1", "New note", 0);
            expect(view.queryByRole("textbox")).toBeNull();
        }
    );

    it("waits for an already-editing note's containing subtree to attach before focusing", async () => {
        const view = setup(true, true);
        await Promise.resolve();
        expect(document.activeElement).toBe(view.getByRole("textbox"));
    });

    it("does not reclaim focus if editing ends before the queued focus runs", async () => {
        const view = setup(true);
        view.setEditingId(null);
        await Promise.resolve();
        expect(view.queryByRole("textbox")).toBeNull();
        expect(document.activeElement).toBe(document.body);
    });

    it("focuses the newly mounted editor each time an existing note is opened", async () => {
        const view = setup();
        const note = view.container.querySelector(".canvas-annotation")!;
        for (let i = 0; i < 2; i++) {
            fireEvent.dblClick(note);
            await Promise.resolve();
            const editor = view.getByRole("textbox");
            expect(document.activeElement).toBe(editor);
            fireEvent.keyDown(editor, { key: "Escape" });
            expect(view.queryByRole("textbox")).toBeNull();
        }
    });

    it.each([0, 400])(
        "keeps wheel events in a focused overflowing note, including its scroll boundary (%s)",
        async (scrollTop) => {
            const view = setup(true);
            await Promise.resolve();
            const editor = view.getByRole("textbox");
            Object.defineProperties(editor, {
                clientHeight: { value: 200 },
                scrollHeight: { value: 600 },
                scrollTop: { value: scrollTop }
            });
            // Canvas listens on window and prevents the native scroll to zoom.
            const onCanvasWheel = vi.fn((event: WheelEvent) => event.preventDefault());
            window.addEventListener("wheel", onCanvasWheel);
            try {
                const wheel = new WheelEvent("wheel", {
                    bubbles: true,
                    cancelable: true,
                    deltaY: 120
                });
                editor.dispatchEvent(wheel);
                expect(onCanvasWheel).not.toHaveBeenCalled();
                expect(wheel.defaultPrevented).toBe(false);
            } finally {
                window.removeEventListener("wheel", onCanvasWheel);
            }
        }
    );

    it("leaves canvas zoom available when the focused note has no overflow", async () => {
        const view = setup(true);
        await Promise.resolve();
        const editor = view.getByRole("textbox");
        Object.defineProperties(editor, {
            clientHeight: { value: 200 },
            scrollHeight: { value: 200 }
        });
        const onCanvasWheel = vi.fn();
        window.addEventListener("wheel", onCanvasWheel);
        try {
            fireEvent.wheel(editor, { deltaY: 120 });
            expect(onCanvasWheel).toHaveBeenCalledOnce();
        } finally {
            window.removeEventListener("wheel", onCanvasWheel);
        }
    });
});

describe("annotationRenderTop", () => {
    it("compensates for the custom Group content area's header offset", () => {
        expect(annotationRenderTop(120, true)).toBe(120 - CUSTOM_GROUP_HEADER_HEIGHT);
    });

    it("leaves a loose canvas annotation in world coordinates", () => {
        expect(annotationRenderTop(120, false)).toBe(120);
    });
});
