import { createSignal, createMemo, Accessor, Setter } from "solid-js";

interface FilterableItem {
    name: string;
    [key: string]: string | string[] | number | boolean | null | undefined;
}

interface UseFilterableItemsOptions<T extends FilterableItem> {
    items: T[];
    categoryMap?: Record<string, number[]>;
    initialCategory?: string;
}

interface FilteredItemWithIndex<T> {
    item: T;
    originalIndex: number;
}

interface UseFilterableItemsReturn<T> {
    searchText: Accessor<string>;
    setSearchText: Setter<string>;
    selectedCategory: Accessor<string>;
    setSelectedCategory: Setter<string>;
    filteredItems: Accessor<FilteredItemWithIndex<T>[]>;
    categories: string[];
    clearFilters: () => void;
}

interface UseMultiFilterableItemsReturn<T> {
    searchText: Accessor<string>;
    setSearchText: Setter<string>;
    selectedCategories: Accessor<Set<string>>;
    toggleCategory: (category: string) => void;
    clearCategories: () => void;
    filteredItems: Accessor<FilteredItemWithIndex<T>[]>;
    categories: string[];
    clearFilters: () => void;
}

export function useMultiFilterableItems<T extends FilterableItem>(
    options: UseFilterableItemsOptions<T>
): UseMultiFilterableItemsReturn<T> {
    const [searchText, setSearchText] = createSignal("");
    const [selectedCategories, setSelectedCategories] = createSignal<Set<string>>(
        new Set()
    );

    const categories = options.categoryMap ? Object.keys(options.categoryMap) : [];

    const toggleCategory = (category: string) => {
        setSelectedCategories((prev) => {
            const next = new Set(prev);
            if (next.has(category)) {
                next.delete(category);
            } else {
                next.add(category);
            }
            return next;
        });
    };

    const filteredItems = createMemo(() => {
        const search = searchText().toLowerCase();
        const selected = selectedCategories();

        let result: FilteredItemWithIndex<T>[] = options.items.map((item, index) => ({
            item,
            originalIndex: index
        }));

        // Filter by categories (union — match ANY selected category)
        if (selected.size > 0 && options.categoryMap) {
            const allowedIndices = new Set<number>();
            for (const cat of selected) {
                const indices = options.categoryMap[cat];
                if (indices) {
                    for (const idx of indices) {
                        allowedIndices.add(idx);
                    }
                }
            }
            result = result.filter(({ originalIndex }) =>
                allowedIndices.has(originalIndex)
            );
        }

        // Then filter by search text
        if (search) {
            result = result.filter(({ item }) =>
                item.name.toLowerCase().includes(search)
            );
        }

        return result;
    });

    const clearCategories = () => {
        setSelectedCategories(new Set<string>());
    };

    const clearFilters = () => {
        setSearchText("");
        clearCategories();
    };

    return {
        searchText,
        setSearchText,
        selectedCategories,
        toggleCategory,
        clearCategories,
        filteredItems,
        categories,
        clearFilters
    };
}

export function useFilterableItems<T extends FilterableItem>(
    options: UseFilterableItemsOptions<T>
): UseFilterableItemsReturn<T> {
    const [searchText, setSearchText] = createSignal("");
    const [selectedCategory, setSelectedCategory] = createSignal(
        options.initialCategory || ""
    );

    const categories = options.categoryMap ? Object.keys(options.categoryMap) : [];

    const filteredItems = createMemo(() => {
        const search = searchText().toLowerCase();
        const category = selectedCategory();

        // Start with all items, preserving original indices
        let result: FilteredItemWithIndex<T>[] = options.items.map((item, index) => ({
            item,
            originalIndex: index
        }));

        // Filter by category first (if selected)
        if (category && options.categoryMap && options.categoryMap[category]) {
            const allowedIndices = new Set(options.categoryMap[category]);
            result = result.filter(({ originalIndex }) =>
                allowedIndices.has(originalIndex)
            );
        }

        // Then filter by search text
        if (search) {
            result = result.filter(({ item }) =>
                item.name.toLowerCase().includes(search)
            );
        }

        return result;
    });

    const clearFilters = () => {
        setSearchText("");
        setSelectedCategory("");
    };

    return {
        searchText,
        setSearchText,
        selectedCategory,
        setSelectedCategory,
        filteredItems,
        categories,
        clearFilters
    };
}
