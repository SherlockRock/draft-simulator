import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { X } from "lucide-solid";
import { champions, getSplashUrl } from "../utils/constants";
import BlankSquare from "/src/assets/BlankSquare.webp";
import { CardLayout, getPickOrderForLayout } from "../utils/canvasCardLayout";

type props = {
    pick: string;
    index: () => number;
    pickIndex?: number;
    handlePickChange: (draftId: string, pickIndex: number, championIndex: string) => void;
    draft: {
        name: string;
        id: string;
        picks: string[];
    };
    indexToShorthand: string[];
    cardLayout: () => CardLayout;
    disabled: boolean;
    focusedDraftId: () => string | null;
    focusedSelectIndex: () => number;
    onFocus: () => void;
    onBlur?: () => void;
    onSelectNext: () => void;
    onSelectPrevious: () => void;
    onSelectMove: (
        axis: "horizontal" | "vertical",
        direction: "forward" | "backward"
    ) => void;
    side?: "team1" | "team2";
    restrictedChampions?: () => string[];
    disabledChampions?: string[];
    displayMode?: "full" | "compact" | "wide-art";
};

export const CanvasSelect = (props: props) => {
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownIndex, setDropdownIndex] = createSignal(0);
    const [selectText, setSelectText] = createSignal("");
    let dropdownRef: HTMLDivElement | undefined;
    const buttonRefs: Map<number, HTMLButtonElement> = new Map();
    let inputRef: HTMLInputElement | undefined;
    let selectionFrameId: number | undefined;
    let wasActiveSelection = false;
    let skipBlurNormalization = false;

    const isCompact = createMemo(() => props.displayMode === "compact");
    const isWideArt = createMemo(() => props.displayMode === "wide-art");
    const shouldFillSlot = createMemo(() => !isCompact());
    const isActiveSelection = createMemo(
        () =>
            props.focusedDraftId() === props.draft.id &&
            props.focusedSelectIndex() === props.index()
    );
    const dropdownWidthClass = createMemo(() => {
        if (isWideArt()) return "left-0 right-0 w-full";
        if (isCompact()) return "left-0 w-56";
        return props.side === "team2" ? "right-0 w-40" : "left-0 w-40";
    });

    const spliceIndexToRealIndex = createMemo(() =>
        getPickOrderForLayout(props.cardLayout())
    );

    const unavailableChampions = createMemo(() => {
        const names: string[] = [];
        for (const value of props.draft.picks) {
            if (value === "") continue;
            const champion = champions[Number(value)];
            if (champion) names.push(champion.name);
        }
        for (const id of props.restrictedChampions?.() ?? []) {
            const champion = champions[Number(id)];
            if (champion) names.push(champion.name);
        }
        for (const id of props.disabledChampions ?? []) {
            const champion = champions[Number(id)];
            if (champion) names.push(champion.name);
        }
        return [...new Set(names)];
    });

    createEffect(() => {
        if (props.pick !== "") {
            setSelectText(champions[Number(props.pick)].name);
        } else {
            setSelectText("");
        }
    });

    createEffect(() => {
        const isActive = isActiveSelection();

        if (isActive && !wasActiveSelection) {
            syncInputWithActiveState();
        } else if (!isActive) {
            cancelPendingSelectionNormalization();
            closeDropdown();
            setDropdownIndex(0);
            setSelectText(restingInputValue());
            skipBlurNormalization = false;
        }

        wasActiveSelection = isActive;
    });

    createEffect(() => {
        const index = dropdownIndex();
        if (dropdownOpen() && index >= 0 && buttonRefs.has(index)) {
            const button = buttonRefs.get(index);
            button?.scrollIntoView({
                block: "nearest"
            });
        }
    });

    const closeDropdown = () => {
        setDropdownOpen(false);
    };

    const onFocusOut = (e: FocusEvent & { currentTarget: HTMLDivElement }) => {
        const nextTarget = e.relatedTarget;
        if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) {
            return;
        }

        closeDropdown();

        if (
            nextTarget instanceof HTMLElement &&
            nextTarget.closest("[data-canvas-select-root='true']")
        ) {
            return;
        }

        props.onBlur?.();
    };

    const activateSelect = () => {
        if (props.disabled) return;

        props.onFocus?.();

        if (isActiveSelection()) {
            if (!isCompact() && !isFilteringOptions()) {
                setSelectText("");
                setDropdownIndex(0);
            }
            syncInputWithActiveState();
        }
    };

    const handleSortOptions = (sortInput: string) => {
        const currentTextIsValid = champions.find(
            (value) => value.name.toLowerCase() === sortInput.toLowerCase()
        );
        if (sortInput === "" || (currentTextIsValid !== undefined && !dropdownOpen())) {
            return champions;
        }
        return champions.filter((option) =>
            option.name.toLowerCase().includes(sortInput.toLowerCase())
        );
    };

    const holdSortOptions = createMemo(() => handleSortOptions(selectText()));

    const commitSelection = (championName: string) => {
        props.handlePickChange(
            props.draft.id,
            props.pickIndex ?? spliceIndexToRealIndex()[props.index()],
            championName
        );
    };

    const clearSelection = () => {
        setSelectText("");
        setDropdownIndex(0);
        commitSelection("");
        inputRef?.focus();
    };

    const selectedChampion = () => {
        return props.pick !== "" ? champions[Number(props.pick)] : null;
    };

    const restingInputValue = () => selectedChampion()?.name || "";
    const placeholderLabel = () => props.indexToShorthand[props.index()];
    const wideArtInputPlaceholder = () =>
        selectedChampion() !== null
            ? `Type to filter ${placeholderLabel()}`
            : placeholderLabel();
    const isFilteringOptions = () =>
        selectText().trim().toLowerCase() !== restingInputValue().trim().toLowerCase();

    const cancelPendingSelectionNormalization = () => {
        if (selectionFrameId !== undefined) {
            cancelAnimationFrame(selectionFrameId);
            selectionFrameId = undefined;
        }
    };

    const focusInput = () => {
        if (!inputRef || document.activeElement === inputRef) return;
        inputRef.focus();
    };

    const syncInputWithActiveState = () => {
        if (!inputRef || !isActiveSelection()) return;

        focusInput();

        cancelPendingSelectionNormalization();
        selectionFrameId = requestAnimationFrame(() => {
            selectionFrameId = undefined;

            if (!inputRef || !isActiveSelection()) return;

            focusInput();
        });
    };

    onCleanup(() => {
        cancelPendingSelectionNormalization();
    });

    const handleInputChange = (newValue: string) => {
        setDropdownIndex(0);
        setSelectText(newValue);
        setDropdownOpen(newValue !== restingInputValue());
    };

    const restoreOrCommitInputValue = () => {
        if (skipBlurNormalization) {
            skipBlurNormalization = false;
            setSelectText(restingInputValue());
            return;
        }

        const inputValue = selectText().trim();
        if (
            inputValue === "" ||
            inputValue.toLowerCase() === restingInputValue().toLowerCase()
        ) {
            setSelectText(restingInputValue());
            return;
        }

        const availableMatches = holdSortOptions().filter(
            (champ) => !unavailableChampions().includes(champ.name)
        );

        if (availableMatches.length === 1) {
            setSelectText(availableMatches[0].name);
            commitSelection(availableMatches[0].name);
        } else {
            setSelectText(restingInputValue());
        }
    };

    const commitHighlightedOption = (moveFocus = true, reverse = false) => {
        if (!dropdownOpen()) {
            setDropdownOpen(true);
            setDropdownIndex(0);
            return;
        }

        const holdOptions = holdSortOptions();
        if (holdOptions.length === 0) {
            setDropdownOpen(true);
            return;
        }

        const hasTypedInput = selectText().trim() !== "";
        const hasExplicitHighlight = dropdownIndex() !== 0;
        const shouldCommitSelection = hasTypedInput || hasExplicitHighlight;

        if (shouldCommitSelection) {
            const holdChampName = holdOptions[dropdownIndex() % holdOptions.length].name;
            const champNotAvailable = unavailableChampions().includes(holdChampName);
            if (!champNotAvailable) {
                setSelectText(holdChampName);
                commitSelection(holdChampName);
            }
        }

        skipBlurNormalization = true;
        setDropdownOpen(false);

        if (moveFocus) {
            if (reverse) {
                props.onSelectPrevious?.();
            } else {
                props.onSelectNext?.();
            }
        }
    };

    const moveFocusedSelect = (
        axis: "horizontal" | "vertical",
        direction: "forward" | "backward"
    ) => {
        props.onSelectMove(axis, direction);
    };

    const handleInputKeyDown = (e: KeyboardEvent) => {
        switch (e.key) {
            case "Enter":
                e.preventDefault();
                e.stopPropagation();
                commitHighlightedOption(true, e.shiftKey);
                return;
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                if (dropdownOpen()) {
                    const optionCount = holdSortOptions().length;
                    if (optionCount > 0) {
                        setDropdownIndex((prevIndex) =>
                            prevIndex === 0 ? optionCount - 1 : prevIndex - 1
                        );
                    }
                    return;
                }
                moveFocusedSelect("vertical", "backward");
                return;
            case "ArrowDown":
                e.preventDefault();
                e.stopPropagation();
                if (dropdownOpen()) {
                    const optionCount = holdSortOptions().length;
                    if (optionCount > 0) {
                        setDropdownIndex((prevIndex) =>
                            prevIndex === optionCount - 1 ? 0 : prevIndex + 1
                        );
                    }
                    return;
                }
                moveFocusedSelect("vertical", "forward");
                return;
            case "ArrowLeft":
                if (!dropdownOpen()) {
                    e.preventDefault();
                    e.stopPropagation();
                    moveFocusedSelect("horizontal", "backward");
                }
                return;
            case "ArrowRight":
                if (!dropdownOpen()) {
                    e.preventDefault();
                    e.stopPropagation();
                    moveFocusedSelect("horizontal", "forward");
                }
                return;
            case "Escape":
                if (selectText().trim() !== "" || selectedChampion() !== null) {
                    e.preventDefault();
                    e.stopPropagation();
                    clearSelection();
                } else if (dropdownOpen()) {
                    e.preventDefault();
                    e.stopPropagation();
                    setDropdownOpen(false);
                }
                return;
        }
    };

    const dropdownClasses = (championName: string, champNotAvailable: boolean) => {
        if (selectedChampion()?.name === championName) {
            return "border-darius-ember/70 text-darius-ember bg-darius-card-hover cursor-not-allowed";
        }
        if (champNotAvailable) {
            return "border-darius-border text-darius-text-secondary bg-darius-card cursor-not-allowed";
        }
        if (
            holdSortOptions().findIndex((value) => value.name === championName) ===
            dropdownIndex()
        ) {
            return "border-darius-purple-bright text-darius-text-primary bg-darius-card-hover hover:bg-darius-card-hover";
        }
        return "border-darius-border text-darius-text-primary bg-darius-card hover:border-darius-purple-bright/50 hover:bg-darius-card-hover";
    };

    return (
        <div
            data-canvas-select-root="true"
            class="relative flex min-h-0 w-full min-w-0"
            classList={{
                "h-full flex-1": shouldFillSlot(),
                "cursor-default": !props.disabled,
                "cursor-not-allowed": props.disabled
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div
                onFocusOut={onFocusOut}
                class="min-h-0 w-full min-w-0 outline-none"
                classList={{ "flex h-full flex-1 flex-col": shouldFillSlot() }}
            >
                <Show
                    when={isCompact()}
                    fallback={
                        <Show
                            when={isWideArt()}
                            fallback={
                                <div
                                    class="flex h-full min-h-0 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-darius-bg px-2 py-1 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                                    onClick={activateSelect}
                                    classList={{
                                        "border-darius-border/80": !isActiveSelection(),
                                        "border-darius-border": !props.disabled,
                                        "border-darius-purple-bright ring-2 ring-darius-purple-bright/35":
                                            isActiveSelection() && !props.disabled
                                    }}
                                >
                                    <div
                                        class="flex min-w-0 flex-1 items-center gap-2"
                                        classList={{
                                            "flex-row-reverse": props.side === "team2"
                                        }}
                                    >
                                        <Show
                                            when={selectedChampion() !== null}
                                            fallback={
                                                <img
                                                    src={BlankSquare}
                                                    alt="blank"
                                                    class="h-6 w-6 shrink-0 rounded-md opacity-70"
                                                />
                                            }
                                        >
                                            <img
                                                src={selectedChampion()?.img}
                                                alt={selectedChampion()?.name}
                                                class="h-6 w-6 shrink-0 rounded-md"
                                            />
                                        </Show>
                                        <input
                                            ref={inputRef}
                                            value={selectText()}
                                            onFocus={activateSelect}
                                            onInput={(e) =>
                                                handleInputChange(e.target.value)
                                            }
                                            onKeyDown={handleInputKeyDown}
                                            onBlur={restoreOrCommitInputValue}
                                            placeholder={placeholderLabel()}
                                            name="select"
                                            id={`${props.draft.id}-${props.index()}-select`}
                                            class="h-6 min-w-0 flex-1 appearance-none bg-inherit px-1 outline-none"
                                            classList={{
                                                "text-darius-crimson":
                                                    props.side === "team1",
                                                "text-darius-ember":
                                                    props.side === "team2",
                                                "text-darius-text-primary": !props.side,
                                                "text-right": props.side === "team2"
                                            }}
                                            disabled={props.disabled}
                                        />
                                    </div>
                                    <Show when={selectedChampion() !== null}>
                                        <button
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                clearSelection();
                                            }}
                                            class={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none transition-all focus:outline-none ${
                                                props.side === "team1"
                                                    ? "text-darius-crimson hover:text-darius-text-primary"
                                                    : props.side === "team2"
                                                      ? "text-darius-ember hover:text-darius-text-primary"
                                                      : "text-darius-text-primary hover:text-darius-purple-bright"
                                            }`}
                                            disabled={props.disabled}
                                        >
                                            <X size={16} />
                                        </button>
                                    </Show>
                                </div>
                            }
                        >
                            <div class="relative flex h-full min-h-0 w-full flex-1">
                                <div
                                    class="relative flex h-full min-h-0 w-full flex-1 items-end overflow-hidden rounded-xl border-2 bg-darius-bg text-left transition-all"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={activateSelect}
                                    classList={{
                                        "border-darius-border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]":
                                            !props.disabled && !isActiveSelection(),
                                        "border-darius-border hover:shadow-[0_12px_30px_rgba(0,0,0,0.3)]":
                                            !props.disabled,
                                        "border-darius-purple-bright ring-2 ring-darius-purple-bright/35":
                                            isActiveSelection() && !props.disabled,
                                        "border-darius-border": props.disabled,
                                        "cursor-not-allowed opacity-60": props.disabled
                                    }}
                                >
                                    <div class="absolute inset-0 bg-darius-bg" />
                                    <Show when={selectedChampion() !== null}>
                                        <img
                                            src={getSplashUrl(selectedChampion()!.name)}
                                            alt={selectedChampion()!.name}
                                            class="absolute -inset-2 block h-[calc(100%+1rem)] w-[calc(100%+1rem)] max-w-none object-cover object-[center_25%]"
                                            classList={{
                                                "-translate-x-[15%] scale-[1.25]":
                                                    props.side === "team1",
                                                "translate-x-[15%] scale-[1.25]":
                                                    props.side === "team2"
                                            }}
                                        />
                                    </Show>
                                    <div class="absolute inset-0 bg-darius-bg/35" />
                                    <Show
                                        when={
                                            selectedChampion() !== null &&
                                            !isActiveSelection()
                                        }
                                        fallback={
                                            <input
                                                ref={inputRef}
                                                value={selectText()}
                                                onFocus={activateSelect}
                                                onInput={(e) => {
                                                    handleInputChange(e.target.value);
                                                }}
                                                onKeyDown={handleInputKeyDown}
                                                onBlur={restoreOrCommitInputValue}
                                                placeholder={wideArtInputPlaceholder()}
                                                name="select"
                                                id={`${props.draft.id}-${props.index()}-select`}
                                                class="relative z-[3] w-full cursor-text appearance-none border-0 bg-transparent px-3 py-2 outline-none"
                                                classList={{
                                                    "text-right": props.side === "team2",
                                                    "text-sm font-semibold uppercase tracking-[0.2em] text-darius-text-secondary caret-darius-text-secondary drop-shadow placeholder:font-semibold placeholder:uppercase placeholder:tracking-[0.2em] text-darius-text-secondary":
                                                        selectedChampion() === null,
                                                    "text-base font-semibold tracking-wide text-darius-text-primary caret-darius-text-primary drop-shadow-lg":
                                                        selectedChampion() !== null
                                                }}
                                                aria-label={
                                                    selectedChampion()?.name ??
                                                    placeholderLabel()
                                                }
                                                disabled={props.disabled}
                                            />
                                        }
                                    >
                                        <div
                                            class="relative z-[3] flex w-full items-end px-3 py-2"
                                            classList={{
                                                "flex-row-reverse": props.side === "team2"
                                            }}
                                        >
                                            <div
                                                class="min-w-0 truncate text-base font-semibold tracking-wide text-darius-text-primary drop-shadow-lg"
                                                classList={{
                                                    "text-right": props.side === "team2"
                                                }}
                                            >
                                                {selectedChampion()!.name}
                                            </div>
                                        </div>
                                    </Show>
                                </div>
                                <Show
                                    when={selectedChampion() !== null && !props.disabled}
                                >
                                    <button
                                        type="button"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            clearSelection();
                                        }}
                                        class="absolute right-2 top-2 z-[4] flex h-5 w-5 items-center justify-center rounded-full border border-darius-border/80 bg-darius-bg/85 bg-darius-card text-darius-text-primary"
                                        aria-label={`Clear ${placeholderLabel()}`}
                                    >
                                        <X size={12} />
                                    </button>
                                </Show>
                            </div>
                        </Show>
                    }
                >
                    <div class="relative">
                        <div
                            class="relative flex h-[30px] w-[30px] items-center justify-center overflow-hidden rounded-lg border bg-darius-bg p-[2px]"
                            onClick={activateSelect}
                            classList={{
                                "border-darius-border/80": !isActiveSelection(),
                                "border-darius-purple-bright ring-2 ring-darius-purple-bright/35":
                                    isActiveSelection() && !props.disabled,
                                "cursor-not-allowed opacity-60": props.disabled
                            }}
                        >
                            <input
                                ref={inputRef}
                                value={selectText()}
                                onFocus={activateSelect}
                                onInput={(e) => {
                                    handleInputChange(e.target.value);
                                }}
                                onKeyDown={handleInputKeyDown}
                                onBlur={restoreOrCommitInputValue}
                                name="select"
                                id={`${props.draft.id}-${props.index()}-select`}
                                class="absolute inset-0 z-[2] h-full w-full cursor-text appearance-none border-0 bg-transparent text-transparent caret-transparent outline-none"
                                aria-label={selectedChampion()?.name ?? "Champion ban"}
                                disabled={props.disabled}
                            />
                            <Show
                                when={selectedChampion() !== null}
                                fallback={
                                    <img
                                        src={BlankSquare}
                                        alt="blank"
                                        class="h-full w-full rounded-md object-cover opacity-70"
                                    />
                                }
                            >
                                <img
                                    src={selectedChampion()?.img}
                                    alt={selectedChampion()?.name}
                                    class="h-full w-full rounded-md object-cover"
                                />
                            </Show>
                        </div>
                        <Show when={selectedChampion() !== null && !props.disabled}>
                            <button
                                type="button"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    clearSelection();
                                }}
                                class="absolute -right-1 -top-1 z-[3] flex h-3.5 w-3.5 items-center justify-center rounded-full border border-darius-border/80 bg-darius-bg bg-darius-card-hover text-darius-text-primary shadow-sm"
                                aria-label={`Clear ${placeholderLabel()}`}
                            >
                                <X size={10} />
                            </button>
                        </Show>
                    </div>
                </Show>

                <Show when={dropdownOpen() && !props.disabled}>
                    <div
                        ref={dropdownRef}
                        class={`absolute z-10 overflow-auto rounded-xl border shadow-[0_18px_40px_rgba(15,23,42,0.55)] ${dropdownWidthClass()}`}
                        classList={{
                            "max-h-60 border-darius-border bg-darius-bg": !isWideArt(),
                            "top-full mt-1 custom-scrollbar max-h-[28rem] border-darius-border/90 bg-darius-bg/98":
                                isWideArt()
                        }}
                        onWheel={(e) => e.stopPropagation()}
                    >
                        <div
                            class="relative z-[1]"
                            classList={{
                                "min-h-full px-2 pt-2 pb-2": isWideArt()
                            }}
                        >
                            <Show when={isWideArt()}>
                                <div class="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
                                    <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(155,80,192,0.16),_transparent_48%),linear-gradient(180deg,rgba(26,16,24,0.96),rgba(42,26,40,0.98))]" />
                                    <div class="absolute inset-2 rounded-lg border border-darius-border/70 bg-darius-bg/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" />
                                </div>
                            </Show>
                            <Show
                                when={holdSortOptions().length > 0}
                                fallback={
                                    <div
                                        classList={{
                                            "px-2 py-2": !isWideArt()
                                        }}
                                    >
                                        <div class="relative px-3 py-2 text-sm text-darius-text-secondary">
                                            No champions match "{selectText().trim()}"
                                        </div>
                                    </div>
                                }
                            >
                                <div>
                                    <For each={holdSortOptions()}>
                                        {(champion, i) => {
                                            const champNotAvailable = () =>
                                                unavailableChampions().includes(
                                                    champion.name
                                                );
                                            const isHighlighted = () =>
                                                i() === dropdownIndex();
                                            return (
                                                <Show
                                                    when={isWideArt()}
                                                    fallback={
                                                        <button
                                                            ref={(el) =>
                                                                buttonRefs.set(i(), el)
                                                            }
                                                            class={`flex w-full items-center gap-2 border-l-4 p-2 text-left text-sm ${dropdownClasses(
                                                                champion.name,
                                                                champNotAvailable()
                                                            )}`}
                                                            onMouseDown={(e) => {
                                                                e.preventDefault();
                                                                if (
                                                                    !champNotAvailable()
                                                                ) {
                                                                    setSelectText(
                                                                        champion.name
                                                                    );
                                                                    commitSelection(
                                                                        champion.name
                                                                    );
                                                                    setDropdownOpen(
                                                                        false
                                                                    );
                                                                }
                                                            }}
                                                            onMouseEnter={() =>
                                                                setDropdownIndex(i())
                                                            }
                                                            disabled={champNotAvailable()}
                                                        >
                                                            <img
                                                                src={champion.img}
                                                                alt={champion.name}
                                                                class="h-6 w-6 rounded"
                                                            />
                                                            <span>{champion.name}</span>
                                                        </button>
                                                    }
                                                >
                                                    <button
                                                        ref={(el) =>
                                                            buttonRefs.set(i(), el)
                                                        }
                                                        type="button"
                                                        class="relative mb-1.5 flex h-24 w-full overflow-hidden rounded-lg border text-left transition-[border-color,box-shadow] last:mb-0"
                                                        classList={{
                                                            "cursor-not-allowed border-darius-ember/70 ring-1 ring-darius-ember/30":
                                                                selectedChampion()
                                                                    ?.name ===
                                                                champion.name,
                                                            "cursor-not-allowed border-darius-border/90":
                                                                selectedChampion()
                                                                    ?.name !==
                                                                    champion.name &&
                                                                champNotAvailable(),
                                                            "border-darius-purple-bright ring-2 ring-darius-purple-bright/35":
                                                                selectedChampion()
                                                                    ?.name !==
                                                                    champion.name &&
                                                                !champNotAvailable() &&
                                                                isHighlighted(),
                                                            "border-darius-border/80 hover:border-darius-purple-bright/50":
                                                                selectedChampion()
                                                                    ?.name !==
                                                                    champion.name &&
                                                                !champNotAvailable() &&
                                                                !isHighlighted()
                                                        }}
                                                        onMouseDown={(e) => {
                                                            e.preventDefault();
                                                            if (!champNotAvailable()) {
                                                                setSelectText(
                                                                    champion.name
                                                                );
                                                                commitSelection(
                                                                    champion.name
                                                                );
                                                                setDropdownOpen(false);
                                                            }
                                                        }}
                                                        onMouseEnter={() =>
                                                            setDropdownIndex(i())
                                                        }
                                                        disabled={champNotAvailable()}
                                                    >
                                                        <img
                                                            src={getSplashUrl(
                                                                champion.name
                                                            )}
                                                            alt={champion.name}
                                                            class="absolute -inset-2 block h-[calc(100%+1rem)] w-[calc(100%+1rem)] max-w-none object-cover object-[center_25%]"
                                                            classList={{
                                                                "-translate-x-[12%] scale-[1.12]":
                                                                    props.side ===
                                                                    "team1",
                                                                "translate-x-[12%] scale-[1.12]":
                                                                    props.side ===
                                                                    "team2",
                                                                "saturate-[0.55]":
                                                                    champNotAvailable()
                                                            }}
                                                        />
                                                        <div
                                                            class="absolute inset-0 bg-gradient-to-r"
                                                            classList={{
                                                                "from-darius-bg/95 via-darius-bg/60 to-darius-bg/35":
                                                                    props.side !==
                                                                    "team2",
                                                                "from-darius-bg/35 via-darius-bg/60 to-darius-bg/95":
                                                                    props.side === "team2"
                                                            }}
                                                        />
                                                        <div class="via-darius-bg/72 absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-darius-bg/95 to-transparent" />
                                                        <div
                                                            class="absolute inset-0"
                                                            classList={{
                                                                "bg-darius-bg/55":
                                                                    champNotAvailable(),
                                                                "bg-darius-ember/15":
                                                                    !champNotAvailable() &&
                                                                    selectedChampion()
                                                                        ?.name ===
                                                                        champion.name,
                                                                "bg-darius-bg/38":
                                                                    !champNotAvailable() &&
                                                                    selectedChampion()
                                                                        ?.name !==
                                                                        champion.name &&
                                                                    !isHighlighted(),
                                                                "bg-darius-bg/10":
                                                                    !champNotAvailable() &&
                                                                    isHighlighted() &&
                                                                    selectedChampion()
                                                                        ?.name !==
                                                                        champion.name
                                                            }}
                                                        />
                                                        <div
                                                            class="relative z-[1] flex h-full w-full items-end px-3 py-2.5"
                                                            classList={{
                                                                "flex-row-reverse":
                                                                    props.side ===
                                                                    "team2",
                                                                "opacity-50":
                                                                    champNotAvailable()
                                                            }}
                                                        >
                                                            <div class="min-w-0">
                                                                <div class="truncate text-base font-semibold text-darius-text-primary drop-shadow-lg">
                                                                    {champion.name}
                                                                </div>
                                                                <div class="mt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-darius-text-secondary/95">
                                                                    {selectedChampion()
                                                                        ?.name ===
                                                                    champion.name
                                                                        ? "Selected"
                                                                        : champNotAvailable()
                                                                          ? "Unavailable"
                                                                          : placeholderLabel()}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </button>
                                                </Show>
                                            );
                                        }}
                                    </For>
                                </div>
                            </Show>
                        </div>
                    </div>
                </Show>
            </div>
        </div>
    );
};
