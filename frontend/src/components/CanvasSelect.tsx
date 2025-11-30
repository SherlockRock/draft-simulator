import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import KeyEvent, { Key } from "../KeyEvent";
import { champions } from "../utils/constants";
import BlankSquare from "/src/assets/BlankSquare.webp";

const indexToShorthand = [
    "BB1",
    "BB2",
    "BB3",
    "BB4",
    "BB5",
    "B1",
    "B2",
    "B3",
    "B4",
    "B5",
    "R1",
    "R2",
    "R3",
    "R4",
    "R5",
    "RB1",
    "RB2",
    "RB3",
    "RB4",
    "RB5"
];

const spliceIndexToRealIndex = [
    0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 5, 6, 7, 8, 9
];

type props = {
    pick: string;
    index: () => number;
    handlePickChange: (draftId: string, pickIndex: number, championIndex: string) => void;
    draft: {
        name: string;
        id: string;
        picks: string[];
    };
};

export const CanvasSelect = (props: props) => {
    const [isFocused, setIsFocused] = createSignal(false);
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownIndex, setDropdownIndex] = createSignal(-1);
    const [selectText, setSelectText] = createSignal("");
    const [unavailableChampions, setUnavailableChampions] = createSignal<string[]>([]);

    // Refs for scroll management
    let dropdownRef: HTMLDivElement | undefined;
    const buttonRefs: Map<number, HTMLButtonElement> = new Map();

    createEffect(() => {
        setUnavailableChampions(
            props.draft.picks
                .filter((value) => value !== "")
                .map((value) => champions[Number(value)].name)
        );
    });

    createEffect(() => {
        if (props.pick !== "") {
            setSelectText(champions[Number(props.pick)].name);
        }
    });

    // Auto-scroll effect when dropdown index changes
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

    const onFocusOut = () => {
        setIsFocused(false);
        closeDropdown();
    };

    const onFocusIn = () => {
        setIsFocused(true);
        setDropdownOpen(true);
    };

    const handleSortOptions = (sortInput: string) => {
        const currentTextIsValid = champions.find(
            (value) => value.name.toLowerCase() === sortInput.toLowerCase()
        );
        if (sortInput === "" || currentTextIsValid !== undefined) {
            return champions;
        }
        return champions.filter((option) =>
            option.name.toLowerCase().includes(sortInput.toLowerCase())
        );
    };

    const holdSortOptions = createMemo(() => {
        const hold = handleSortOptions(selectText());
        return hold;
    });

    const handleKeyEvent = (key: Key) => {
        if (!isFocused()) return;
        switch (key) {
            case "Enter":
                if (dropdownOpen() && dropdownIndex() >= 0) {
                    const holdOptions = holdSortOptions();
                    const holdChampName =
                        holdOptions[dropdownIndex() % holdOptions.length].name;
                    setSelectText(holdChampName);
                    setDropdownOpen(false);
                    props.handlePickChange(
                        props.draft.id,
                        spliceIndexToRealIndex[props.index()],
                        holdChampName
                    );
                }
                break;
            case "ArrowUp":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === 0) {
                            return holdSortOptions().length - 1;
                        }
                        return prevIndex - 1;
                    });
                }
                break;
            case "ArrowDown":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === holdSortOptions().length - 1) {
                            return 0;
                        }
                        return prevIndex + 1;
                    });
                } else {
                    setDropdownOpen(true);
                }
                break;
            case "Escape":
                if (dropdownOpen()) {
                    setDropdownOpen(false);
                } else {
                    setSelectText("");
                }
        }
    };

    const selectedChampion = () => {
        return props.pick !== "" ? champions[Number(props.pick)] : null;
    };

    const dropdownClasses = (championName: string, champNotAvailable: boolean) => {
        if (selectedChampion()?.name === championName) {
            return "border-green-600 text-green-600 bg-slate-800 cursor-not-allowed";
        }
        if (champNotAvailable) {
            return "border-slate-400 text-red-500 bg-slate-500 cursor-not-allowed";
        }
        if (
            holdSortOptions().findIndex((value) => value.name === championName) ===
            dropdownIndex()
        ) {
            return "border-teal-400 text-teal-400 bg-slate-800 hover:border-teal-400 hover:bg-slate-600 hover:text-teal-400";
        }
        return "border-black text-slate-50 bg-slate-800 hover:border-teal-400 hover:bg-slate-600 hover:text-teal-400";
    };

    return (
        <div class="relative flex w-full justify-center">
            <KeyEvent
                onKeyUp={handleKeyEvent}
                keys={["Enter", "ArrowUp", "ArrowDown", "Escape"]}
            />
            <div onFocusIn={onFocusIn} onFocusOut={onFocusOut} tabIndex={0}>
                <div class="flex w-40 items-center gap-2 rounded bg-slate-800 p-1 text-left text-sm hover:bg-slate-700">
                    <Show
                        when={selectedChampion() !== null}
                        fallback={
                            <img src={BlankSquare} alt="blank" class="h-6 w-6 rounded" />
                        }
                    >
                        <img
                            src={selectedChampion()?.img}
                            alt={selectedChampion()?.name}
                            class="h-6 w-6 rounded"
                        />
                    </Show>
                    <input
                        value={selectText() ?? indexToShorthand[props.index()]}
                        onInput={(e) => {
                            setDropdownIndex(0);
                            setSelectText(e.target.value);
                        }}
                        placeholder={indexToShorthand[props.index()]}
                        name="select"
                        id="select"
                        class="h-6 w-full appearance-none bg-inherit px-1 text-slate-50 outline-none placeholder:text-slate-200"
                    />
                    <Show when={selectedChampion() !== null}>
                        <button
                            onClick={() => {
                                setSelectText("");
                                setDropdownIndex(0);
                                props.handlePickChange(
                                    props.draft.id,
                                    spliceIndexToRealIndex[props.index()],
                                    ""
                                );
                            }}
                            class="cursor-pointer text-slate-200 outline-none transition-all hover:text-teal-400 focus:outline-none"
                        >
                            <svg
                                class="h-4 w-4 fill-current"
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>
                    </Show>
                </div>

                <Show when={dropdownOpen()}>
                    <div
                        ref={dropdownRef}
                        class="absolute z-10 mt-1 max-h-60 w-40 overflow-auto rounded border border-slate-500 bg-white shadow-lg"
                        onWheel={(e) => e.stopPropagation()}
                    >
                        <For each={holdSortOptions()}>
                            {(champion, i) => {
                                const champNotAvailable = unavailableChampions().includes(
                                    champion.name
                                );
                                return (
                                    <button
                                        ref={(el) => buttonRefs.set(i(), el)}
                                        class={`flex w-full items-center gap-2 border-l-4 p-2 text-left text-sm ${dropdownClasses(
                                            champion.name,
                                            champNotAvailable
                                        )}`}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            if (!champNotAvailable) {
                                                setSelectText(champion.name);
                                                props.handlePickChange(
                                                    props.draft.id,
                                                    spliceIndexToRealIndex[props.index()],
                                                    champion.name
                                                );
                                                setDropdownOpen(false);
                                            }
                                        }}
                                        disabled={champNotAvailable}
                                    >
                                        <img
                                            src={champion.img}
                                            alt={champion.name}
                                            class="h-6 w-6 rounded"
                                        />
                                        <span>{champion.name}</span>
                                    </button>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </div>
        </div>
    );
};
