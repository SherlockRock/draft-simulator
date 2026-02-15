import {
    For,
    Index,
    onCleanup,
    createMemo,
    createSignal,
    createEffect,
    Resource,
    Setter,
    Suspense,
    Switch,
    Match,
    JSX,
    Show
} from "solid-js";
import {
    botChamps,
    champions,
    jungleChamps,
    midChamps,
    sortOptions,
    supportChamps,
    topChamps
} from "./utils/constants";
import { useNavigate, useParams } from "@solidjs/router";
import { useUser } from "./userProvider";
import { SearchableSelect } from "./components/SearchableSelect";
import {
    createDraggable,
    createDroppable,
    DragDropProvider,
    DragDropSensors,
    DragEventHandler,
    DragOverlay
} from "@thisbeyond/solid-dnd";
import { draft } from "./utils/schemas";
import BlankSquare from "/src/assets/BlankSquare.webp";
import { useQueryClient } from "@tanstack/solid-query";
import { SelectTheme } from "./utils/selectTheme";

type draggableProps = {
    name: string;
    children: JSX.Element;
};
const DraggableWrapper = (props: draggableProps) => {
    const draggable = createDraggable(props.name);

    return (
        <div use:draggable class="draggable w-full">
            {props.children}
        </div>
    );
};

type droppableProps = {
    id: number;
    children: JSX.Element;
};
const Droppable = (props: droppableProps) => {
    const droppable = createDroppable(props.id);

    return (
        <div
            use:droppable
            class="droppable w-fit"
            classList={{ "!droppable-accept": droppable.isActiveDroppable }}
        >
            {props.children}
        </div>
    );
};

type props = {
    draft: Resource<any>;
    mutate: Setter<any>;
    isLocked?: boolean;
    blueTeamName?: string;
    redTeamName?: string;
    theme?: SelectTheme;
};

function Draft(props: props) {
    const params = useParams();
    const navigate = useNavigate();
    const accessor = useUser();
    const socketAccessor = accessor()[2];
    const queryClient = useQueryClient();
    const [searchWord, setSearchWord] = createSignal("");
    const [selectedChampion, setSelectedChampion] = createSignal("");
    const [selectText, setSelectText] = createSignal("");
    const [currentlySelected, setCurrentlySelected] = createSignal("");
    const [currentDragged, setCurrentDragged] = createSignal("");
    const [anonDraft, setAnonDraft] = createSignal<boolean>(true);

    createEffect(() => {
        const holdDraft = props.draft();
        if (holdDraft && anonDraft()) {
            setAnonDraft(false);
            navigate(`/canvas/${params.id}/draft/${holdDraft.id}`, { replace: true });
            socketAccessor().emit("joinRoom", holdDraft.id);
        }
    });

    createEffect(() => {
        socketAccessor().on(
            "draftUpdate",
            (data: { picks: string[]; id: string } | draft) => {
                if ("owner_id" in data) {
                    props.mutate(() => ({
                        ...data,
                        picks: [...data.picks]
                    }));
                } else {
                    props.mutate((old) => ({
                        ...old,
                        picks: [...data.picks]
                    }));
                }
            }
        );
        onCleanup(() => {
            socketAccessor().off("draftUpdate");
        });
    });

    const handleSearch = (
        event: InputEvent & {
            currentTarget: HTMLInputElement;
            target: HTMLInputElement;
        }
    ) => {
        setSearchWord(event.target.value);
    };

    const handleSelectText = (newText: string) => {
        setSelectText(newText);
        setCurrentlySelected("");
    };

    const handlePick = (index: number, championId: string) => {
        if (props.isLocked) return;
        const holdPicks = [
            ...props
                .draft()
                .picks.map((pick: string) => (pick === championId ? "" : pick))
        ];
        if (index !== -1) {
            holdPicks[index] = championId;
        }
        props.mutate((old) => ({
            ...old,
            picks: [...holdPicks]
        }));
        socketAccessor().emit("newDraft", {
            picks: holdPicks,
            id: params.draftId
        });
        setSelectedChampion("");
        setCurrentDragged("");
        queryClient.invalidateQueries({ queryKey: ["canvas"] });
    };

    const handleSelect = (index: number) => {
        if (selectedChampion() !== "" || props.draft().picks[index] !== "") {
            handlePick(index, selectedChampion());
        }
    };

    const onDragStart: DragEventHandler = (args) => {
        if (props.isLocked) return;
        setCurrentDragged(String(args.draggable.id).split("-")[1]);
    };

    // Clear activeChamp when drag ends
    const onDragEnd: DragEventHandler = (event) => {
        if (props.isLocked) return;
        if (event.droppable) {
            handlePick(Number(event.droppable.id), currentDragged());
        } else {
            setCurrentDragged("");
        }
    };

    const tableClass = (champ: string) => {
        const champNum = String(champions.findIndex((c) => c.name === champ));
        if (selectedChampion() === champNum) {
            return "block w-full border-2 border-blue-700 hover:cursor-move";
        } else if (props.draft().picks.includes(champNum)) {
            return "block w-full border-2 border-gray-950 brightness-[30%]";
        }
        return "block w-full border-2 border-black hover:cursor-move";
    };

    const picksClasses = (champ: string, side: "team1" | "team2") => {
        const borderColor = side === "team1" ? "border-violet-400" : "border-fuchsia-400";
        return champ === "" && selectedChampion() === ""
            ? `aspect-square w-[min(8vw,120px)] border-2 ${borderColor}`
            : `aspect-square w-[min(8vw,120px)] border-2 ${borderColor} hover:cursor-pointer`;
    };
    const bansClasses = (champ: string, side: "team1" | "team2") => {
        const borderColor = side === "team1" ? "border-violet-400" : "border-fuchsia-400";
        return champ === "" && selectedChampion() === ""
            ? `aspect-square w-[min(6vw,120px)] border-2 ${borderColor}`
            : `aspect-square w-[min(6vw,120px)] border-2 ${borderColor} hover:cursor-pointer`;
    };

    const handleSelectedChamp = (champ: string) => {
        if (props.isLocked) return;
        if (!props.draft().picks.includes(champ)) {
            setSelectedChampion(champ);
        }
    };

    const onValidSelect = (newValue: string) => {
        setCurrentlySelected(newValue);
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

    const champNumberToImg = (champ: string) => {
        return champ === "" ? "" : champions[Number(champ)].img;
    };

    const holdChamps = createMemo(() => sortChamps(searchWord(), selectText()));

    return (
        <div class="flex h-full w-full flex-col px-2" draggable="false">
            <Suspense fallback={<div>Loading...</div>}>
                <DragDropProvider onDragEnd={onDragEnd} onDragStart={onDragStart}>
                    <Show when={currentDragged() !== ""}>
                        <DragOverlay>
                            <img
                                class="w-[min(8vw,120px)]"
                                src={champNumberToImg(currentDragged())}
                                onClick={() =>
                                    handleSelectedChamp(String(currentDragged()))
                                }
                                draggable="false"
                            />
                        </DragOverlay>
                    </Show>
                    <DragDropSensors />
                    <Switch>
                        <Match when={props.draft.error}>
                            <span>Error: {props.draft.error.message}</span>
                        </Match>
                        <Match when={props.draft()}>
                            <div class="mb-2 flex items-center justify-between rounded bg-slate-700/50 px-4 py-2">
                                <span class="text-lg font-semibold text-violet-300">
                                    {props.blueTeamName ?? "Team 1"}
                                </span>
                                <Show when={props.isLocked}>
                                    <span
                                        class="cursor-help rounded bg-slate-500/30 px-2 py-1 text-sm text-slate-400"
                                        title="Imported from versus series. Cannot be edited."
                                    >
                                        Locked
                                    </span>
                                </Show>
                                <span class="text-lg font-semibold text-fuchsia-300">
                                    {props.redTeamName ?? "Team 2"}
                                </span>
                            </div>
                            <div class="flex w-full justify-center self-center pt-2">
                                <div
                                    class="flex w-full justify-between self-center"
                                    classList={{ "pointer-events-none": props.isLocked }}
                                >
                                    {/* All 10 bans */}
                                    <Index each={props.draft().picks.slice(0, 10)}>
                                        {(each, index) => {
                                            const side = index < 5 ? "team1" : "team2";
                                            const borderColor =
                                                side === "team1"
                                                    ? "border-violet-400"
                                                    : "border-fuchsia-400";
                                            return (
                                                <>
                                                    <Droppable id={index}>
                                                        <Show
                                                            when={each()}
                                                            keyed
                                                            fallback={
                                                                <div
                                                                    class={`aspect-square w-[min(6vw,120px)] border-2 ${borderColor}`}
                                                                >
                                                                    <img
                                                                        src={BlankSquare}
                                                                        draggable="false"
                                                                        onClick={() =>
                                                                            handleSelect(
                                                                                index
                                                                            )
                                                                        }
                                                                    />
                                                                </div>
                                                            }
                                                        >
                                                            <DraggableWrapper
                                                                name={`banned-${each()}`}
                                                            >
                                                                <div
                                                                    class={bansClasses(
                                                                        each(),
                                                                        side
                                                                    )}
                                                                    onClick={() =>
                                                                        handleSelect(
                                                                            index
                                                                        )
                                                                    }
                                                                >
                                                                    <img
                                                                        src={champNumberToImg(
                                                                            each()
                                                                        )}
                                                                        draggable="false"
                                                                    />
                                                                </div>
                                                            </DraggableWrapper>
                                                        </Show>
                                                    </Droppable>
                                                    {index === 4 && (
                                                        <div class="inline-block min-h-max w-0.5 self-stretch bg-neutral-100 opacity-100 dark:opacity-50" />
                                                    )}
                                                </>
                                            );
                                        }}
                                    </Index>
                                </div>
                            </div>
                            <div class="flex min-h-0 w-full flex-1 justify-evenly self-center pt-4">
                                <div
                                    class="flex flex-col justify-between gap-1 pb-8"
                                    classList={{ "pointer-events-none": props.isLocked }}
                                >
                                    {/* Blue Side Champions */}
                                    <Index each={props.draft().picks.slice(10, 15)}>
                                        {(each, index) => (
                                            <Droppable id={index + 10}>
                                                <Show
                                                    when={each()}
                                                    keyed
                                                    fallback={
                                                        <div class="aspect-square w-[min(8vw,120px)] border-2 border-violet-400">
                                                            <img
                                                                src={BlankSquare}
                                                                draggable="false"
                                                                onClick={() =>
                                                                    handleSelect(
                                                                        index + 10
                                                                    )
                                                                }
                                                            />
                                                        </div>
                                                    }
                                                >
                                                    <DraggableWrapper
                                                        name={`picked-${each()}`}
                                                    >
                                                        <div
                                                            class={picksClasses(
                                                                each(),
                                                                "team1"
                                                            )}
                                                            onClick={() =>
                                                                handleSelect(index + 10)
                                                            }
                                                        >
                                                            <img
                                                                src={champNumberToImg(
                                                                    each()
                                                                )}
                                                                draggable="false"
                                                            />
                                                        </div>
                                                    </DraggableWrapper>
                                                </Show>
                                            </Droppable>
                                        )}
                                    </Index>
                                </div>
                                <div class="flex min-h-0 w-[min(40vw,600px)] flex-col rounded-t-md">
                                    <div class="flex rounded-tl-md bg-slate-800">
                                        <input
                                            class="w-full rounded-tl-md bg-slate-800 p-1 text-slate-50 placeholder:text-slate-200 focus:outline-none"
                                            type="text"
                                            value={searchWord()}
                                            onInput={handleSearch}
                                            placeholder="Search Champions..."
                                        />
                                        <SearchableSelect
                                            placeholder="Sort by Role"
                                            currentlySelected={currentlySelected()}
                                            sortOptions={sortOptions}
                                            selectText={selectText()}
                                            setSelectText={handleSelectText}
                                            onValidSelect={onValidSelect}
                                            theme={props.theme}
                                        />
                                    </div>
                                    <div class="custom-scrollbar min-h-0 flex-1 overflow-auto">
                                        <Droppable id={-1}>
                                            <div
                                                class="grid grid-cols-5 gap-0"
                                                classList={{
                                                    "pointer-events-none opacity-60":
                                                        props.isLocked
                                                }}
                                            >
                                                {/* Table Search Results */}
                                                <For each={holdChamps()}>
                                                    {(champ, index) => (
                                                        <>
                                                            <DraggableWrapper
                                                                name={`unpicked-${index()}`}
                                                            >
                                                                <img
                                                                    class={tableClass(
                                                                        String(champ.name)
                                                                    )}
                                                                    src={champ.img}
                                                                    onClick={() =>
                                                                        handleSelectedChamp(
                                                                            String(
                                                                                index()
                                                                            )
                                                                        )
                                                                    }
                                                                    draggable="false"
                                                                />
                                                            </DraggableWrapper>
                                                        </>
                                                    )}
                                                </For>
                                            </div>
                                        </Droppable>
                                    </div>
                                </div>
                                <div
                                    class="flex flex-col justify-between gap-1 pb-8"
                                    classList={{ "pointer-events-none": props.isLocked }}
                                >
                                    {/* Red Side Champions */}
                                    <Index each={props.draft().picks.slice(15, 20)}>
                                        {(each, index) => (
                                            <Droppable id={index + 15}>
                                                <Show
                                                    when={each()}
                                                    keyed
                                                    fallback={
                                                        <div class="aspect-square w-[min(8vw,120px)] border-2 border-fuchsia-400">
                                                            <img
                                                                src={BlankSquare}
                                                                draggable="false"
                                                                onClick={() =>
                                                                    handleSelect(
                                                                        index + 15
                                                                    )
                                                                }
                                                            />
                                                        </div>
                                                    }
                                                >
                                                    <DraggableWrapper
                                                        name={`picked-${each()}`}
                                                    >
                                                        <div
                                                            class={picksClasses(
                                                                each(),
                                                                "team2"
                                                            )}
                                                            onClick={() =>
                                                                handleSelect(index + 15)
                                                            }
                                                        >
                                                            <img
                                                                src={champNumberToImg(
                                                                    each()
                                                                )}
                                                                draggable="false"
                                                            />
                                                        </div>
                                                    </DraggableWrapper>
                                                </Show>
                                            </Droppable>
                                        )}
                                    </Index>
                                </div>
                            </div>
                        </Match>
                    </Switch>
                </DragDropProvider>
            </Suspense>
        </div>
    );
}

export default Draft;
