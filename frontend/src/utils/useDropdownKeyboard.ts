import { createEffect, createSignal, Accessor } from "solid-js";

export type DropdownKeyboardOptions = {
    getItemCount: () => number;
    onSelect: (index: number) => void;
    onClose: () => void;
    isOpen: Accessor<boolean>;
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
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                return "open";
            }
            return;
        }

        const count = options.getItemCount();
        if (count === 0) return;

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setHighlightedIndex((prev) => (prev >= count - 1 ? 0 : prev + 1));
                break;
            case "ArrowUp":
                e.preventDefault();
                setHighlightedIndex((prev) => (prev <= 0 ? count - 1 : prev - 1));
                break;
            case "Enter":
            case " ":
                e.preventDefault();
                if (highlightedIndex() >= 0) {
                    options.onSelect(highlightedIndex());
                }
                break;
            case "Escape":
                e.preventDefault();
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
