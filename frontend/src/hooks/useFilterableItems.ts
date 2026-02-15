import { createSignal, createMemo, Accessor, Setter } from "solid-js";

interface FilterableItem {
    name: string;
    [key: string]: string | number | boolean | null | undefined;
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
