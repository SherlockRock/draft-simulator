# Filterable Image Grid Design

## Overview

Add search and category filtering to champion/icon selection grids across multiple components. Users can search by name and filter by role (champions) or category (emojis).

## Affected Components

- `VersusDraftView.tsx` - Champion grid in sidebar
- `PickChangeModal.tsx` - Champion selection in modal
- `IconPicker.tsx` - Champions and emojis tabs

## Architecture

### Shared Hook: `useFilterableItems`

A generic hook that handles filtering logic for any item list.

```typescript
// frontend/src/hooks/useFilterableItems.ts

interface FilterableItem {
    name: string;
    [key: string]: any;
}

interface UseFilterableItemsOptions<T extends FilterableItem> {
    items: T[];
    categoryMap?: Record<string, number[]>;
    initialCategory?: string;
}

interface UseFilterableItemsReturn<T> {
    searchText: Accessor<string>;
    setSearchText: Setter<string>;
    selectedCategory: Accessor<string>;
    setSelectedCategory: Setter<string>;
    filteredItems: Accessor<T[]>;
    categories: string[];
    clearFilters: () => void;
}
```

The hook:
- Maintains `searchText` and `selectedCategory` signals
- Computes `filteredItems` using `createMemo` - filters by category first (if set), then by search text
- Exposes `categories` array from `categoryMap` keys
- Provides `clearFilters` helper

### Shared UI Component: `FilterBar`

A presentational component for the search input and category dropdown.

```typescript
// frontend/src/components/FilterBar.tsx

interface FilterBarProps {
    searchText: Accessor<string>;
    onSearchChange: (value: string) => void;
    selectedCategory: Accessor<string>;
    onCategoryChange: (value: string) => void;
    categories: string[];
    searchPlaceholder?: string;
    categoryPlaceholder?: string;
}
```

Renders:
- Search input (left)
- Category dropdown using `SearchableSelect` (right)

Styling matches Draft.tsx: `bg-slate-800`, `text-slate-50`, `border-teal-700`.

### Data Structures

**Champion categories** (new export in constants.ts):
```typescript
export const championCategories: Record<string, number[]> = {
    "Top": topChamps,
    "Jungle": jungleChamps,
    "Mid": midChamps,
    "Bot": botChamps,
    "Support": supportChamps
};
```

**Emoji data** (converted from string array to objects):
```typescript
export const EMOJI_OPTIONS = [
    { name: "Sword", emoji: "⚔️", category: "combat" },
    { name: "Shield", emoji: "🛡️", category: "combat" },
    // ...
];

export const emojiCategories: Record<string, number[]> = {
    "Combat": [...],
    "Elements": [...],
    "Creatures": [...],
    "Nature": [...],
    "Symbols": [...]
};
```

## Component Integration

### VersusDraftView.tsx

```typescript
const { searchText, setSearchText, selectedCategory, setSelectedCategory, filteredItems } =
    useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
```

Add FilterBar above the champion grid in the sidebar.

### PickChangeModal.tsx

```typescript
const { searchText, setSearchText, selectedCategory, setSelectedCategory, filteredItems } =
    useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
```

Add FilterBar in the "Step 2: Select new champion" section.

### IconPicker.tsx

```typescript
const championFilter = useFilterableItems({
    items: champions,
    categoryMap: championCategories
});

const emojiFilter = useFilterableItems({
    items: EMOJI_OPTIONS,
    categoryMap: emojiCategories
});
```

Two hook instances, one per tab. Clear filters when switching tabs.

## Implementation Order

1. Update `constants.ts` with new data structures
2. Create `useFilterableItems` hook
3. Create `FilterBar` component
4. Update `VersusDraftView` (simplest integration)
5. Update `PickChangeModal`
6. Update `IconPicker` (most complex - two filter instances)

## Out of Scope

- No changes to `Draft.tsx` (already has this functionality)
- Selection/click handling stays in each component
- Grid layouts and styling stay in each component
