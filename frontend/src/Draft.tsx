import {
    For,
    Index,
    onCleanup,
    createMemo,
    createSignal,
    createEffect,
    createResource,
    Suspense,
    Switch,
    Match
} from "solid-js";
import {
    botChamps,
    champions,
    jungleChamps,
    midChamps,
    sortOptions,
    supportChamps,
    topChamps
} from "./constants";
import KeyEvent, { Key } from "./KeyEvent";
import { useNavigate, useParams } from "@solidjs/router";
import DraftList from "./DraftList";
import Chat from "./Chat";
import { useUser } from "./userProvider";

function Draft() {
    const params = useParams();
    const navigate = useNavigate();
    const accessor = useUser();
    const socket = accessor()[2];
    const [searchWord, setSearchWord] = createSignal("");
    const [selectedChampion, setSelectedChampion] = createSignal("");
    const [currentlySorting, setCurrentlySorting] = createSignal("");
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownIndex, setDropdownIndex] = createSignal(0);
    const fetchDraft = async (id: string) => {
        const res = await fetch(`https://localhost:3000/api/drafts/${id}`, {
            method: "GET"
        });
        const hold = await res.json();
        if (hold === null) {
            return { picks: [...Array(20)].map(() => ""), id: "" };
        } else if ("id" in hold) {
            // Join a room
            socket.emit("joinRoom", hold.id);
            return hold;
        }
        // Join a room
        socket.emit("joinRoom", hold[0].id);
        return hold[0];
    };
    const [draft, { mutate }] = createResource(
        () => (params.session !== undefined ? String(params.session) : ""),
        fetchDraft
    );

    // Handle Socket.IO events
    createEffect(() => {
        const holdDraft = draft();
        if (holdDraft !== undefined && holdDraft.picks.length !== 0) {
            navigate(`/${draft().id}`);
        }
    });

    socket.on("draftUpdate", (data: { picks: string[] }) => {
        if (data.picks.length !== 0) {
            mutate((old) => ({
                ...old,
                picks: [...data.picks]
            }));
        }
    });

    onCleanup(() => {
        socket.off("draftUpdate");
        socket.disconnect();
    });

    const handleSearch = (
        event: InputEvent & {
            currentTarget: HTMLInputElement;
            target: HTMLInputElement;
        }
    ) => {
        setSearchWord(event.target.value);
    };

    const handleSortInput = (
        event: InputEvent & {
            currentTarget: HTMLInputElement;
            target: HTMLInputElement;
        }
    ) => {
        setCurrentlySorting(event.target.value);
        setDropdownIndex(0);
    };

    const flipDropdown = () => {
        setDropdownOpen(!dropdownOpen());
    };

    const openDropdown = () => {
        setDropdownOpen(true);
    };

    const closeDropdown = () => {
        setDropdownOpen(false);
    };

    const handlePick = (index: number) => {
        const holdPicks = [...draft().picks];
        holdPicks[index] = selectedChampion();
        mutate((old) => ({
            ...old,
            picks: [...holdPicks]
        }));
        setSelectedChampion("");
        socket.emit("newDraft", {
            picks: holdPicks,
            id: params.session
        });
    };

    const tableClass = (champ: string) => {
        if (selectedChampion() === champ) {
            return "border-2 border-blue-700 hover:cursor-pointer";
        } else if (draft().picks.includes(champ)) {
            return "border-2 border-gray-950 brightness-[30%]";
        }
        return "border-2 border-black hover:cursor-pointer";
    };

    const picksAndBansClass = (champ: string) => {
        return champ === "" && selectedChampion() === ""
            ? "h-[120px] w-[120px] border-4 border-gray-800"
            : "h-[120px] w-[120px] border-4 border-gray-800 hover:cursor-pointer";
    };

    const handleSelectedChamp = (champ: string) => {
        if (!draft().picks.includes(champ)) {
            setSelectedChampion(champ);
        }
    };

    const sortChamps = (searchWord: string, currentlySorting: string) => {
        let holdChamps;
        switch (currentlySorting) {
            case "Top":
                holdChamps = topChamps.map((each) => champions[each]);
                break;
            case "Jungle":
                holdChamps = jungleChamps.map((each) => champions[each]);
                break;
            case "Mid":
                holdChamps = midChamps.map((each) => champions[each]);
                break;
            case "Bot":
                holdChamps = botChamps.map((each) => champions[each]);
                break;
            case "Support":
                holdChamps = supportChamps.map((each) => champions[each]);
                break;
            default:
                holdChamps = [...champions];
                break;
        }
        return holdChamps.filter((champ) =>
            champ.name.toLowerCase().includes(searchWord)
        );
    };

    const handleSortOptions = (sortInput: string) =>
        sortOptions.filter((option) => option.toLowerCase().includes(sortInput));
    const holdChamps = createMemo(() => sortChamps(searchWord(), currentlySorting()));
    const holdSortOptions = createMemo(() => handleSortOptions(currentlySorting()));

    const handleKeyEvent = (key: Key) => {
        switch (key) {
            case "Enter":
                if (dropdownOpen()) {
                    const hold = holdSortOptions();
                    setCurrentlySorting(hold[dropdownIndex() % hold.length]);
                    setDropdownOpen(false);
                }
                break;
            case "ArrowUp":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === 0) {
                            return 4;
                        }
                        return prevIndex - 1;
                    });
                }
                break;
            case "ArrowDown":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === 4) {
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
                    setCurrentlySorting("");
                }
        }
    };

    const handleOptionSelected = (
        index: number,
        currentIndex: number,
        options: string[]
    ) => {
        return index === currentIndex % options.length;
    };

    const champNumberToImg = (champ: string) => {
        return champ === "" ? "" : champions[Number(champ)].img;
    };

    return (
        <div class="flex h-full w-full flex-col p-2">
            <Suspense fallback={<div>Loading...</div>}>
                <Switch>
                    <Match when={draft.error}>
                        <span>Error: {draft.error.message}</span>
                    </Match>
                    <Match when={draft()}>
                        <KeyEvent
                            onKeyUp={handleKeyEvent}
                            keys={["Enter", "ArrowUp", "ArrowDown", "Escape"]}
                        />
                        <div class="flex w-full justify-center self-center">
                            <div class="flex w-full justify-evenly gap-1 self-center">
                                {/* All 10 bans */}
                                <Index each={draft().picks.slice(0, 10)}>
                                    {(each, index) => (
                                        <>
                                            <div
                                                class={picksAndBansClass(each())}
                                                onClick={() => handlePick(index)}
                                            >
                                                <img src={champNumberToImg(each())} />
                                            </div>
                                            {index === 4 && (
                                                <div class="inline-block h-[120px] min-h-[1em] w-0.5 self-stretch bg-neutral-100 opacity-100 dark:opacity-50" />
                                            )}
                                        </>
                                    )}
                                </Index>
                            </div>
                        </div>
                        <div class="flex w-full justify-center self-center pt-4">
                            <div class="flex flex-col justify-between gap-1">
                                {/* Blue Side Champions */}
                                <Index each={draft().picks.slice(10, 15)}>
                                    {(each, index) => (
                                        <div
                                            class={picksAndBansClass(each())}
                                            onClick={() => handlePick(index + 10)}
                                        >
                                            <img src={champNumberToImg(each())} />
                                        </div>
                                    )}
                                </Index>
                            </div>
                            <div class="mx-4 w-[600px]">
                                <div class="flex">
                                    <input
                                        class="w-full bg-gray-950 p-1 text-white focus:outline-none"
                                        type="text"
                                        value={searchWord()}
                                        onInput={handleSearch}
                                        placeholder="Search Champions..."
                                    />
                                    {/* <img
              class="h-8 hover:cursor-pointer"
              src="/src/assets/icon-position-top.webp"
              onClick={() => setCurrentlySorting("top")}
            />
            <img
              class="h-8 hover:cursor-pointer"
              src="/src/assets/icon-position-jungle.webp"
              onClick={() => setCurrentlySorting("jungle")}
            />
            <img
              class="h-8 hover:cursor-pointer"
              src="/src/assets/icon-position-middle.webp"
              onClick={() => setCurrentlySorting("mid")}
            />
            <img
              class="h-8 hover:cursor-pointer"
              src="/src/assets/icon-position-bottom.webp"
              onClick={() => setCurrentlySorting("bot")}
            />
            <img
              class="h-8 hover:cursor-pointer"
              src="/src/assets/icon-position-support.webp"
              onClick={() => setCurrentlySorting("support")}
            /> */}
                                    <div
                                        class="mx-auto max-w-md"
                                        onFocusOut={closeDropdown}
                                    >
                                        <div class="relative">
                                            <div class="flex h-10 items-center border border-blue-600 bg-gray-950">
                                                <input
                                                    value={currentlySorting()}
                                                    onInput={handleSortInput}
                                                    onFocus={openDropdown}
                                                    name="select"
                                                    id="select"
                                                    class="w-full appearance-none bg-inherit px-4 text-white outline-none"
                                                />
                                                <button
                                                    onClick={() =>
                                                        setCurrentlySorting("")
                                                    }
                                                    class="cursor-pointer text-white outline-none transition-all hover:text-gray-600 focus:outline-none"
                                                >
                                                    <svg
                                                        class="mx-2 h-4 w-4 fill-current"
                                                        xmlns="http://www.w3.org/2000/svg"
                                                        viewBox="0 0 24 24"
                                                        stroke="currentColor"
                                                        stroke-width="2"
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                    >
                                                        <line
                                                            x1="18"
                                                            y1="6"
                                                            x2="6"
                                                            y2="18"
                                                        />
                                                        <line
                                                            x1="6"
                                                            y1="6"
                                                            x2="18"
                                                            y2="18"
                                                        />
                                                    </svg>
                                                </button>
                                                <label
                                                    for="show_more"
                                                    class="cursor-pointer border-l text-gray-300 outline-none transition-all hover:text-gray-600 focus:outline-none"
                                                >
                                                    <svg
                                                        class="mx-2 h-4 w-4 fill-current"
                                                        xmlns="http://www.w3.org/2000/svg"
                                                        viewBox="0 0 24 24"
                                                        stroke="currentColor"
                                                        stroke-width="2"
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        onClick={flipDropdown}
                                                    >
                                                        <polyline points="18 15 12 9 6 15" />
                                                    </svg>
                                                </label>
                                            </div>
                                            {dropdownOpen() && (
                                                <div class="absolute z-10 w-full flex-col border border-t-0 border-blue-600">
                                                    <For each={holdSortOptions()}>
                                                        {(option, index) => (
                                                            <div
                                                                class="group cursor-pointer"
                                                                onMouseDown={() => {
                                                                    setCurrentlySorting(
                                                                        option
                                                                    );
                                                                    flipDropdown();
                                                                }}
                                                            >
                                                                <a
                                                                    class="block border-l-4 bg-gray-950 p-2 text-white group-hover:border-blue-600 group-hover:bg-gray-800"
                                                                    classList={{
                                                                        "border-blue-600 bg-gray-800":
                                                                            handleOptionSelected(
                                                                                index(),
                                                                                dropdownIndex(),
                                                                                holdSortOptions()
                                                                            )
                                                                    }}
                                                                >
                                                                    {option}
                                                                </a>
                                                            </div>
                                                        )}
                                                    </For>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div class="h-[600px] overflow-auto">
                                    <div class="z-0 grid grid-cols-5">
                                        {/* Table Search Results */}
                                        <For each={holdChamps()}>
                                            {(champ, index) => (
                                                <img
                                                    class={tableClass(String(index()))}
                                                    src={champ.img}
                                                    onClick={() =>
                                                        handleSelectedChamp(
                                                            String(index())
                                                        )
                                                    }
                                                />
                                            )}
                                        </For>
                                    </div>
                                </div>
                            </div>
                            <div class="flex flex-col justify-between gap-1">
                                {/* Red Side Champions */}
                                <Index each={draft().picks.slice(15, 20)}>
                                    {(each, index) => (
                                        <div
                                            class={picksAndBansClass(each())}
                                            onClick={() => handlePick(index + 15)}
                                        >
                                            <img src={champNumberToImg(each())} />
                                        </div>
                                    )}
                                </Index>
                            </div>
                        </div>
                    </Match>
                </Switch>
            </Suspense>
            <DraftList currentDraft={draft()?.id} />
            <Chat currentDraft={draft()?.id} />
        </div>
    );
}

export default Draft;
