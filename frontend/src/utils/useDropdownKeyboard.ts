import { createEffect, createSignal, Accessor } from "solid-js";

export type DropdownKeyboardOptions = {
    getItemCount: () => number;
    onSelect: (index: number) => void;
    onClose: () => void;
    isOpen: Accessor<boolean>;
    /** Text-input mode: space types, Enter only selects unambiguously, only ArrowDown opens. */
    textInput?: Accessor<boolean | undefined>;
};

export function createDropdownKeyboard(options: DropdownKeyboardOptions) {
    const [highlightedIndex, setHighlightedIndex] = createSignal(-1);

    // Store refs to dropdown items for scroll-into-view
    const itemRefs: HTMLElement[] = [];

    // Auto-scroll to keep highlighted item in view
    createEffect(() => {
        const index = highlightedIndex();
        if (index >= 0 && itemRefs[index]) {
            itemRefs[index].scrollIntoView({ block: "nearest" });
        }
    });

    const setItemRef = (index: number, el: HTMLElement) => {
        itemRefs[index] = el;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (!options.isOpen()) {
            if (options.textInput?.()) {
                // Text inputs: Enter and space must type/bubble; only ArrowDown opens
                if (e.key === "ArrowDown") return "open";
                return;
            }
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                return "open";
            }
            return;
        }

        const count = options.getItemCount();
        if (count === 0) return;

        const consume = () => {
            e.preventDefault();
            e.stopPropagation();
        };

        switch (e.key) {
            case "ArrowDown":
                consume();
                setHighlightedIndex((prev) => (prev >= count - 1 ? 0 : prev + 1));
                break;
            case "ArrowUp":
                consume();
                setHighlightedIndex((prev) => (prev <= 0 ? count - 1 : prev - 1));
                break;
            case "Enter":
                if (highlightedIndex() >= 0) {
                    consume();
                    options.onSelect(highlightedIndex());
                } else if (options.textInput?.() && count === 1) {
                    consume();
                    options.onSelect(0);
                } else if (!options.textInput?.()) {
                    consume();
                }
                break;
            case " ":
                if (options.textInput?.()) break;
                consume();
                if (highlightedIndex() >= 0) {
                    options.onSelect(highlightedIndex());
                }
                break;
            case "Escape":
                consume();
                options.onClose();
                break;
            case "Tab":
                options.onClose();
                break;
        }
    };

    const resetIndex = (index = -1) => setHighlightedIndex(index);

    return {
        highlightedIndex,
        setHighlightedIndex,
        setItemRef,
        handleKeyDown,
        resetIndex
    };
}
