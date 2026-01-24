# Filterable Image Grid Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add search and category filtering to champion/icon selection grids in VersusDraftView, PickChangeModal, and IconPicker.

**Architecture:** Create a shared `useFilterableItems` hook for filtering logic and a `FilterBar` component for the UI. Each consumer component maintains its own selection behavior but uses the shared filtering.

**Tech Stack:** SolidJS (signals, createMemo), TypeScript, Tailwind CSS

---

## Task 1: Add Champion Categories to Constants

**Files:**
- Modify: `frontend/src/utils/constants.ts:373-375` (after supportChamps)

**Step 1: Add championCategories export**

Add this after line 375 (after `sortOptions`):

```typescript
export const championCategories: Record<string, number[]> = {
    Top: topChamps,
    Jungle: jungleChamps,
    Mid: midChamps,
    Bot: botChamps,
    Support: supportChamps
};
```

**Step 2: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to constants.ts

**Step 3: Commit**

```bash
git add frontend/src/utils/constants.ts
git commit -m "feat: add championCategories map to constants"
```

---

## Task 2: Add Emoji Data with Categories to Constants

**Files:**
- Modify: `frontend/src/utils/constants.ts` (add at end of file)

**Step 1: Add emoji data structure with names and categories**

Add at the end of constants.ts:

```typescript
export const EMOJI_OPTIONS = [
    // Combat (0-5)
    { name: "Swords", emoji: "⚔️", category: "Combat" },
    { name: "Shield", emoji: "🛡️", category: "Combat" },
    { name: "Bow", emoji: "🏹", category: "Combat" },
    { name: "Dagger", emoji: "🗡️", category: "Combat" },
    { name: "Axe", emoji: "🪓", category: "Combat" },
    { name: "Trident", emoji: "🔱", category: "Combat" },
    // Elements (6-19)
    { name: "Lightning", emoji: "⚡", category: "Elements" },
    { name: "Fire", emoji: "🔥", category: "Elements" },
    { name: "Ice", emoji: "❄️", category: "Elements" },
    { name: "Water", emoji: "💧", category: "Elements" },
    { name: "Star", emoji: "🌟", category: "Elements" },
    { name: "Sparkles", emoji: "✨", category: "Elements" },
    { name: "Dizzy", emoji: "💫", category: "Elements" },
    { name: "Moon", emoji: "🌙", category: "Elements" },
    { name: "Sun", emoji: "☀️", category: "Elements" },
    { name: "Rainbow", emoji: "🌈", category: "Elements" },
    { name: "Cloud", emoji: "☁️", category: "Elements" },
    { name: "Wind", emoji: "💨", category: "Elements" },
    { name: "Wave", emoji: "🌊", category: "Elements" },
    { name: "Volcano", emoji: "🌋", category: "Elements" },
    // Creatures (20-42)
    { name: "Lion", emoji: "🦁", category: "Creatures" },
    { name: "Dragon", emoji: "🐉", category: "Creatures" },
    { name: "Eagle", emoji: "🦅", category: "Creatures" },
    { name: "Wolf", emoji: "🐺", category: "Creatures" },
    { name: "Tiger", emoji: "🐯", category: "Creatures" },
    { name: "Shark", emoji: "🦈", category: "Creatures" },
    { name: "Scorpion", emoji: "🦂", category: "Creatures" },
    { name: "Snake", emoji: "🐍", category: "Creatures" },
    { name: "Spider", emoji: "🕷️", category: "Creatures" },
    { name: "Bat", emoji: "🦇", category: "Creatures" },
    { name: "Dragon Face", emoji: "🐲", category: "Creatures" },
    { name: "T-Rex", emoji: "🦖", category: "Creatures" },
    { name: "Sauropod", emoji: "🦕", category: "Creatures" },
    { name: "Octopus", emoji: "🐙", category: "Creatures" },
    { name: "Squid", emoji: "🦑", category: "Creatures" },
    { name: "Lizard", emoji: "🦎", category: "Creatures" },
    { name: "Turtle", emoji: "🐢", category: "Creatures" },
    { name: "Crab", emoji: "🦀", category: "Creatures" },
    { name: "Lobster", emoji: "🦞", category: "Creatures" },
    { name: "Shrimp", emoji: "🦐", category: "Creatures" },
    // Fantasy (43-52)
    { name: "Skull", emoji: "💀", category: "Fantasy" },
    { name: "Ghost", emoji: "👻", category: "Fantasy" },
    { name: "Ogre", emoji: "👹", category: "Fantasy" },
    { name: "Goblin", emoji: "👺", category: "Fantasy" },
    { name: "Robot", emoji: "🤖", category: "Fantasy" },
    { name: "Alien", emoji: "👽", category: "Fantasy" },
    { name: "Mage", emoji: "🧙", category: "Fantasy" },
    { name: "Fairy", emoji: "🧚", category: "Fantasy" },
    { name: "Vampire", emoji: "🧛", category: "Fantasy" },
    { name: "Zombie", emoji: "🧟", category: "Fantasy" },
    // Symbols (53-72)
    { name: "Crown", emoji: "👑", category: "Symbols" },
    { name: "Gem", emoji: "💎", category: "Symbols" },
    { name: "Trophy", emoji: "🏆", category: "Symbols" },
    { name: "Bullseye", emoji: "🎯", category: "Symbols" },
    { name: "Controller", emoji: "🎮", category: "Symbols" },
    { name: "Dice", emoji: "🎲", category: "Symbols" },
    { name: "Masks", emoji: "🎭", category: "Symbols" },
    { name: "Palette", emoji: "🎨", category: "Symbols" },
    { name: "Circus", emoji: "🎪", category: "Symbols" },
    { name: "Clapper", emoji: "🎬", category: "Symbols" },
    { name: "Glowing Star", emoji: "⭐", category: "Symbols" },
    { name: "Shooting Star", emoji: "🌠", category: "Symbols" },
    { name: "Collision", emoji: "💥", category: "Symbols" },
    { name: "Bright", emoji: "🔆", category: "Symbols" },
    { name: "Milky Way", emoji: "🌌", category: "Symbols" },
    { name: "Night City", emoji: "🌃", category: "Symbols" },
    { name: "Cityscape", emoji: "🌆", category: "Symbols" },
    { name: "Mountain", emoji: "🏔️", category: "Symbols" },
    { name: "Fuji", emoji: "🗻", category: "Symbols" },
    { name: "Castle", emoji: "🏰", category: "Symbols" },
    // Mystical (73-87)
    { name: "Moai", emoji: "🗿", category: "Mystical" },
    { name: "Key", emoji: "🗝️", category: "Mystical" },
    { name: "Scroll", emoji: "📜", category: "Mystical" },
    { name: "Book", emoji: "📖", category: "Mystical" },
    { name: "Crystal Ball", emoji: "🔮", category: "Mystical" },
    { name: "Magic Wand", emoji: "🪄", category: "Mystical" },
    { name: "Pill", emoji: "💊", category: "Mystical" },
    { name: "Potion", emoji: "🧪", category: "Mystical" },
    { name: "Alembic", emoji: "⚗️", category: "Mystical" },
    { name: "Microscope", emoji: "🔬", category: "Mystical" },
    { name: "DNA", emoji: "🧬", category: "Mystical" },
    { name: "Bone", emoji: "🦴", category: "Mystical" },
    { name: "Nazar", emoji: "🧿", category: "Mystical" },
    { name: "Beads", emoji: "📿", category: "Mystical" },
    { name: "Pumpkin", emoji: "🎃", category: "Mystical" },
    // Body (88-91)
    { name: "Eye", emoji: "👁️", category: "Body" },
    { name: "Brain", emoji: "🧠", category: "Body" },
    // Hearts (92-99)
    { name: "Red Heart", emoji: "❤️", category: "Hearts" },
    { name: "Blue Heart", emoji: "💙", category: "Hearts" },
    { name: "Green Heart", emoji: "💚", category: "Hearts" },
    { name: "Yellow Heart", emoji: "💛", category: "Hearts" },
    { name: "Purple Heart", emoji: "💜", category: "Hearts" },
    { name: "Black Heart", emoji: "🖤", category: "Hearts" },
    { name: "White Heart", emoji: "🤍", category: "Hearts" },
    { name: "Orange Heart", emoji: "🧡", category: "Hearts" },
    // Nature (100-107)
    { name: "Leaf", emoji: "🍃", category: "Nature" },
    { name: "Herb", emoji: "🌿", category: "Nature" },
    { name: "Clover", emoji: "🍀", category: "Nature" },
    { name: "Hibiscus", emoji: "🌺", category: "Nature" },
    { name: "Cherry Blossom", emoji: "🌸", category: "Nature" },
    { name: "Sunflower", emoji: "🌼", category: "Nature" },
    { name: "Wilted Flower", emoji: "🥀", category: "Nature" },
    { name: "Plant", emoji: "🪴", category: "Nature" }
];

export const emojiCategories: Record<string, number[]> = {
    Combat: [0, 1, 2, 3, 4, 5],
    Elements: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    Creatures: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
    Fantasy: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
    Symbols: [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69],
    Mystical: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84],
    Body: [85, 86],
    Hearts: [87, 88, 89, 90, 91, 92, 93, 94],
    Nature: [95, 96, 97, 98, 99, 100, 101, 102]
};
```

**Step 2: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/utils/constants.ts
git commit -m "feat: add EMOJI_OPTIONS with names/categories and emojiCategories map"
```

---

## Task 3: Create useFilterableItems Hook

**Files:**
- Create: `frontend/src/hooks/useFilterableItems.ts`

**Step 1: Create hooks directory**

Run: `mkdir -p /home/rsmith/draft-simulator/frontend/src/hooks`

**Step 2: Create the hook file**

```typescript
import { createSignal, createMemo, Accessor, Setter } from "solid-js";

interface FilterableItem {
    name: string;
    [key: string]: any;
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
            result = result.filter(({ originalIndex }) => allowedIndices.has(originalIndex));
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
```

**Step 3: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add frontend/src/hooks/useFilterableItems.ts
git commit -m "feat: add useFilterableItems hook for search and category filtering"
```

---

## Task 4: Create FilterBar Component

**Files:**
- Create: `frontend/src/components/FilterBar.tsx`

**Step 1: Create the component**

```typescript
import { Accessor, Component } from "solid-js";
import { SearchableSelect } from "./SearchableSelect";

interface FilterBarProps {
    searchText: Accessor<string>;
    onSearchChange: (value: string) => void;
    selectedCategory: Accessor<string>;
    onCategoryChange: (value: string) => void;
    categories: string[];
    searchPlaceholder?: string;
    categoryPlaceholder?: string;
}

export const FilterBar: Component<FilterBarProps> = (props) => {
    return (
        <div class="flex rounded-md bg-slate-800">
            <input
                type="text"
                value={props.searchText()}
                onInput={(e) => props.onSearchChange(e.currentTarget.value)}
                placeholder={props.searchPlaceholder || "Search..."}
                class="w-full bg-inherit p-2 text-slate-50 placeholder:text-slate-400 focus:outline-none"
            />
            <SearchableSelect
                placeholder={props.categoryPlaceholder || "Filter"}
                currentlySelected={props.selectedCategory()}
                sortOptions={props.categories}
                selectText={props.selectedCategory()}
                setSelectText={props.onCategoryChange}
                onValidSelect={props.onCategoryChange}
            />
        </div>
    );
};
```

**Step 2: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/components/FilterBar.tsx
git commit -m "feat: add FilterBar component for search and category dropdown"
```

---

## Task 5: Integrate FilterBar into VersusDraftView

**Files:**
- Modify: `frontend/src/pages/VersusDraftView.tsx`

**Step 1: Add imports**

Add after line 25 (after the last import):

```typescript
import { useFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "../components/FilterBar";
import { championCategories } from "../utils/constants";
```

**Step 2: Add the hook inside the component**

Add after line 88 (after `pendingPickChangeRequest` signal):

```typescript
    // Champion filtering
    const {
        searchText,
        setSearchText,
        selectedCategory,
        setSelectedCategory,
        filteredItems: filteredChampions,
        categories: championCategoryList
    } = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
```

**Step 3: Replace the champion grid section**

Replace lines 842-889 (the Champion Grid section) with:

```typescript
                        {/* Champion Grid */}
                        <div class="w-96 border-l border-slate-700 bg-slate-800 pb-4 pl-0 pr-0 pt-4">
                            <div class="mb-2 px-4 text-lg font-semibold text-slate-200">
                                Champions
                            </div>
                            <div class="px-4 pb-2">
                                <FilterBar
                                    searchText={searchText}
                                    onSearchChange={setSearchText}
                                    selectedCategory={selectedCategory}
                                    onCategoryChange={setSelectedCategory}
                                    categories={championCategoryList}
                                    searchPlaceholder="Search champions..."
                                    categoryPlaceholder="Role"
                                />
                            </div>
                            <div
                                class="grid grid-cols-4 gap-2 overflow-y-auto px-4 py-2"
                                style={{ height: "calc(100vh - 260px)" }}
                            >
                                <For each={filteredChampions()}>
                                    {({ item: champ, originalIndex }) => {
                                        const isPicked = () =>
                                            draft()!.picks.includes(String(originalIndex));
                                        const isPendingSelection = () =>
                                            getCurrentPendingChampion() ===
                                                String(originalIndex) && isMyTurn();
                                        const canSelect = () =>
                                            isMyTurn() &&
                                            !isPicked() &&
                                            !versusState().isPaused;

                                        return (
                                            <button
                                                onClick={() =>
                                                    canSelect() &&
                                                    handleChampionSelect(String(originalIndex))
                                                }
                                                class={`relative h-16 w-16 rounded border-2 transition-all ${
                                                    isPicked() && !isPendingSelection()
                                                        ? "cursor-not-allowed border-slate-700 opacity-30"
                                                        : isPendingSelection()
                                                          ? "scale-110 cursor-pointer border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                          : canSelect()
                                                            ? "cursor-pointer border-teal-500 hover:scale-105 hover:border-teal-400"
                                                            : "cursor-not-allowed border-slate-700 opacity-50"
                                                }`}
                                                title={champ.name}
                                            >
                                                <img
                                                    src={champ.img}
                                                    alt={champ.name}
                                                    class="h-full w-full rounded object-cover"
                                                />
                                            </button>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
```

**Step 4: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/src/pages/VersusDraftView.tsx
git commit -m "feat: add search and role filter to VersusDraftView champion grid"
```

---

## Task 6: Integrate FilterBar into PickChangeModal

**Files:**
- Modify: `frontend/src/components/PickChangeModal.tsx`

**Step 1: Add imports**

Add after line 3 (after champions import):

```typescript
import { useFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "./FilterBar";
import { championCategories } from "../utils/constants";
```

**Step 2: Add the hook inside the component**

Add after line 28 (after `myTeam` function):

```typescript
    // Champion filtering for Step 2
    const {
        searchText,
        setSearchText,
        selectedCategory,
        setSelectedCategory,
        filteredItems: filteredChampions,
        categories: championCategoryList,
        clearFilters
    } = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
```

**Step 3: Clear filters when modal opens**

Update the `handleOpenModal` function (around line 75) to clear filters:

```typescript
    const handleOpenModal = () => {
        if (isSpectator() || !props.draft?.completed) return;
        setIsOpen(true);
        setSelectedPickIndex(null);
        setSelectedChampion(null);
        clearFilters();
    };
```

**Step 4: Replace the champion grid in Step 2**

Replace lines 204-251 (the Step 2 section's grid) with:

```typescript
                        <Show when={selectedPickIndex() !== null}>
                            <div class="mb-6">
                                <h3 class="mb-2 text-lg font-semibold text-slate-200">
                                    Step 2: Select new champion
                                </h3>
                                <div class="mb-2">
                                    <FilterBar
                                        searchText={searchText}
                                        onSearchChange={setSearchText}
                                        selectedCategory={selectedCategory}
                                        onCategoryChange={setSelectedCategory}
                                        categories={championCategoryList}
                                        searchPlaceholder="Search champions..."
                                        categoryPlaceholder="Role"
                                    />
                                </div>
                                <div class="max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-4">
                                    <div class="grid grid-cols-10 gap-1">
                                        <For each={filteredChampions()}>
                                            {({ item: champion, originalIndex }) => {
                                                const champIndex = () => String(originalIndex);
                                                const isAlreadyPicked = () =>
                                                    props.draft?.picks?.includes(
                                                        champIndex()
                                                    ) || false;
                                                const isSelected = () =>
                                                    selectedChampion() === champIndex();

                                                return (
                                                    <button
                                                        onClick={() =>
                                                            handleSelectChampion(
                                                                champIndex()
                                                            )
                                                        }
                                                        disabled={isAlreadyPicked()}
                                                        title={champion.name}
                                                        class={`h-12 w-12 flex-shrink-0 rounded border-2 transition-all ${
                                                            isSelected()
                                                                ? "border-teal-500"
                                                                : isAlreadyPicked()
                                                                  ? "cursor-not-allowed border-transparent opacity-30"
                                                                  : "border-transparent hover:border-slate-500"
                                                        }`}
                                                    >
                                                        <img
                                                            src={champion.img}
                                                            alt={champion.name}
                                                            class={`h-full w-full rounded ${isAlreadyPicked() ? "grayscale" : ""}`}
                                                        />
                                                    </button>
                                                );
                                            }}
                                        </For>
                                    </div>
                                </div>
                            </div>
                        </Show>
```

**Step 5: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 6: Commit**

```bash
git add frontend/src/components/PickChangeModal.tsx
git commit -m "feat: add search and role filter to PickChangeModal champion grid"
```

---

## Task 7: Integrate FilterBar into IconPicker

**Files:**
- Modify: `frontend/src/components/IconPicker.tsx`

**Step 1: Update imports**

Replace the imports (lines 1-3) with:

```typescript
import { createSignal, createEffect, For, Show } from "solid-js";
import { Dialog } from "./Dialog";
import { champions, EMOJI_OPTIONS, championCategories, emojiCategories } from "../utils/constants";
import { useFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "./FilterBar";
```

**Step 2: Remove the local EMOJI_OPTIONS constant**

Delete lines 12-117 (the entire `const EMOJI_OPTIONS = [...]` block).

**Step 3: Add hook instances inside the component**

Add after line 7 (after `const [activeTab, setActiveTab]`), replacing the local signal with two filter hooks:

```typescript
    // Champion filtering
    const championFilter = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Emoji filtering
    const emojiFilter = useFilterableItems({
        items: EMOJI_OPTIONS,
        categoryMap: emojiCategories
    });

    // Clear filters when switching tabs
    createEffect(() => {
        const tab = activeTab();
        championFilter.clearFilters();
        emojiFilter.clearFilters();
    });
```

**Step 4: Update the handleChampionSelect function**

Keep it as-is (it already uses index correctly).

**Step 5: Update the handleEmojiSelect function**

Change from receiving emoji string to receiving the emoji object's emoji field:

```typescript
    const handleEmojiSelect = (emoji: string) => {
        props.onSelect(emoji);
        props.onClose();
    };
```

(This stays the same, but we'll pass the emoji field from the object.)

**Step 6: Replace the content section**

Replace the content section (lines 178-226 approximately, the `<div class="max-h-[60vh]...">` block) with:

```typescript
                    {/* Content */}
                    <div class="max-h-[60vh] overflow-y-auto overflow-x-hidden">
                        <Show when={activeTab() === "champions"}>
                            <div class="mb-2 p-2">
                                <FilterBar
                                    searchText={championFilter.searchText}
                                    onSearchChange={championFilter.setSearchText}
                                    selectedCategory={championFilter.selectedCategory}
                                    onCategoryChange={championFilter.setSelectedCategory}
                                    categories={championFilter.categories}
                                    searchPlaceholder="Search champions..."
                                    categoryPlaceholder="Role"
                                />
                            </div>
                            <div class="grid grid-cols-8 gap-2 p-2 sm:grid-cols-10 md:grid-cols-12">
                                <For each={championFilter.filteredItems()}>
                                    {({ item: champion, originalIndex }) => (
                                        <button
                                            onClick={() => handleChampionSelect(originalIndex)}
                                            class={`group relative aspect-square overflow-hidden rounded border-2 transition-all hover:scale-105 ${
                                                props.currentIcon === originalIndex.toString()
                                                    ? "border-teal-400 ring-2 ring-teal-400"
                                                    : "border-slate-600 hover:border-teal-500"
                                            }`}
                                            title={champion.name}
                                        >
                                            <img
                                                src={champion.img}
                                                alt={champion.name}
                                                class="h-full w-full object-cover"
                                            />
                                            <div class="absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 transition-opacity group-hover:opacity-100">
                                                <span class="text-xs text-white">
                                                    {champion.name}
                                                </span>
                                            </div>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>

                        <Show when={activeTab() === "emojis"}>
                            <div class="mb-2 p-2">
                                <FilterBar
                                    searchText={emojiFilter.searchText}
                                    onSearchChange={emojiFilter.setSearchText}
                                    selectedCategory={emojiFilter.selectedCategory}
                                    onCategoryChange={emojiFilter.setSelectedCategory}
                                    categories={emojiFilter.categories}
                                    searchPlaceholder="Search emojis..."
                                    categoryPlaceholder="Category"
                                />
                            </div>
                            <div class="grid grid-cols-8 gap-2 p-2 sm:grid-cols-10 md:grid-cols-12">
                                <For each={emojiFilter.filteredItems()}>
                                    {({ item: emojiItem }) => (
                                        <button
                                            onClick={() => handleEmojiSelect(emojiItem.emoji)}
                                            class={`flex aspect-square items-center justify-center rounded border-2 text-3xl transition-all hover:scale-105 ${
                                                props.currentIcon === emojiItem.emoji
                                                    ? "border-teal-400 bg-slate-700 ring-2 ring-teal-400"
                                                    : "border-slate-600 bg-slate-800 hover:border-teal-500 hover:bg-slate-700"
                                            }`}
                                            title={emojiItem.name}
                                        >
                                            {emojiItem.emoji}
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>
```

**Step 7: Verify no TypeScript errors**

Run: `cd /home/rsmith/draft-simulator/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 8: Commit**

```bash
git add frontend/src/components/IconPicker.tsx
git commit -m "feat: add search and category filter to IconPicker for champions and emojis"
```

---

## Task 8: Manual Testing Checklist

**Step 1: Start the frontend dev server**

Run: `cd /home/rsmith/draft-simulator/frontend && npm run dev`

**Step 2: Test VersusDraftView**

- [ ] Navigate to a versus draft
- [ ] Search for a champion name (e.g., "Ahri") - grid should filter
- [ ] Select a role (e.g., "Mid") - grid should filter to mid laners
- [ ] Combine search + role - should filter by both
- [ ] Clear search - should show all champions in selected role
- [ ] Clear role dropdown - should show all champions matching search

**Step 3: Test PickChangeModal**

- [ ] Complete a versus draft
- [ ] Click "Request Pick Change"
- [ ] Select a pick to change
- [ ] Verify FilterBar appears in Step 2
- [ ] Search and filter champions
- [ ] Select a new champion
- [ ] Close and reopen modal - filters should be cleared

**Step 4: Test IconPicker**

- [ ] Open icon picker (from team settings or similar)
- [ ] On Champions tab: search and filter by role
- [ ] Switch to Emojis tab - filters should clear
- [ ] Search emojis by name (e.g., "fire", "dragon")
- [ ] Filter emojis by category (e.g., "Creatures", "Elements")
- [ ] Select an emoji - should work correctly

**Step 5: Final commit**

If all tests pass, no additional commit needed. If fixes were required, commit them with appropriate message.
