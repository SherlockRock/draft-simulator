import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Plus } from "lucide-solid";
import type { Team } from "@draft-sim/shared-types";
import { createTeam } from "../utils/actions";
import { createDropdownKeyboard } from "../utils/useDropdownKeyboard";

type TeamNameSelectProps = {
    /** Current display name (entity name when linked, else free text). */
    value: string;
    /** Linked team id, or null when the name is free text. */
    teamId: string | null;
    /** The user's owned teams to autocomplete against. */
    teams: Team[];
    /** Disable entity linking (local/anonymous canvases): plain text input. */
    disabled?: boolean;
    placeholder?: string;
    onChange: (name: string, teamId: string | null) => void;
    /** Called after a new team is created so the parent can refresh its list. */
    onCreated?: (team: Team) => void;
};

type Row = { kind: "team"; team: Team } | { kind: "create"; name: string };

const inputClass =
    "w-full select-text rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none";

export const TeamNameSelect = (props: TeamNameSelectProps) => {
    const [open, setOpen] = createSignal(false);
    const [creating, setCreating] = createSignal(false);
    const [position, setPosition] = createSignal({ top: 0, left: 0, width: 0 });
    let containerRef: HTMLDivElement | undefined;

    const updatePosition = () => {
        if (!containerRef) return;
        const rect = containerRef.getBoundingClientRect();
        setPosition({ top: rect.bottom, left: rect.left, width: rect.width });
    };

    createEffect(() => {
        if (!open()) return;
        updatePosition();
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        onCleanup(() => {
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        });
    });

    const rows = createMemo<Row[]>(() => {
        const query = props.value.trim().toLowerCase();
        const matches = props.teams.filter((team) =>
            team.name.toLowerCase().includes(query)
        );
        const result: Row[] = matches.map((team) => ({ kind: "team", team }));
        const trimmed = props.value.trim();
        const exactExists = props.teams.some((team) => team.name.toLowerCase() === query);
        if (trimmed.length > 0 && !exactExists) {
            result.push({ kind: "create", name: trimmed });
        }
        return result;
    });

    const selectRow = async (row: Row | undefined) => {
        if (!row) return;
        if (row.kind === "team") {
            props.onChange(row.team.name, row.team.id);
            setOpen(false);
            return;
        }
        if (creating()) return;
        setCreating(true);
        try {
            const team = await createTeam(row.name);
            props.onCreated?.(team);
            props.onChange(team.name, team.id);
            setOpen(false);
        } finally {
            setCreating(false);
        }
    };

    const keyboard = createDropdownKeyboard({
        getItemCount: () => rows().length,
        onSelect: (index) => void selectRow(rows()[index]),
        onClose: () => setOpen(false),
        isOpen: open,
        textInput: () => true
    });

    const handleKeyDown = (e: KeyboardEvent) => {
        const result = keyboard.handleKeyDown(e);
        if (result === "open") {
            e.preventDefault();
            e.stopPropagation();
            updatePosition();
            setOpen(true);
            keyboard.resetIndex(0);
        }
    };

    return (
        <Show
            when={!props.disabled}
            fallback={
                <input
                    type="text"
                    value={props.value}
                    placeholder={props.placeholder}
                    onInput={(e) => props.onChange(e.currentTarget.value, null)}
                    class={inputClass}
                />
            }
        >
            <div ref={containerRef} class="relative" onKeyDown={handleKeyDown}>
                <input
                    type="text"
                    value={props.value}
                    placeholder={props.placeholder}
                    onInput={(e) => {
                        keyboard.resetIndex(0);
                        updatePosition();
                        setOpen(true);
                        // Typing detaches any prior link until a row is chosen.
                        props.onChange(e.currentTarget.value, null);
                    }}
                    onFocus={() => {
                        updatePosition();
                        setOpen(true);
                    }}
                    onBlur={() => setOpen(false)}
                    class={inputClass}
                />
                <Show when={open() && rows().length > 0}>
                    <Portal>
                        <div
                            class="custom-scrollbar fixed z-[100] max-h-64 overflow-y-auto rounded-md border border-darius-purple-bright bg-darius-card shadow-lg"
                            style={{
                                top: `${position().top}px`,
                                left: `${position().left}px`,
                                width: `${position().width}px`
                            }}
                        >
                            <For each={rows()}>
                                {(row, index) => (
                                    <div
                                        ref={(el) => keyboard.setItemRef(index(), el)}
                                        class="cursor-pointer"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            void selectRow(row);
                                        }}
                                        onMouseEnter={() =>
                                            keyboard.setHighlightedIndex(index())
                                        }
                                    >
                                        <div
                                            class={`flex items-center gap-2 border-l-4 p-2 text-sm transition-colors ${
                                                index() === keyboard.highlightedIndex()
                                                    ? "border-darius-purple bg-darius-card-hover text-darius-text-primary"
                                                    : "border-transparent text-darius-text-primary hover:bg-darius-card-hover"
                                            }`}
                                        >
                                            <Show
                                                when={row.kind === "create"}
                                                fallback={
                                                    <span class="truncate">
                                                        {row.kind === "team"
                                                            ? row.team.name
                                                            : ""}
                                                    </span>
                                                }
                                            >
                                                <Plus
                                                    size={14}
                                                    class="shrink-0 text-darius-purple-bright"
                                                />
                                                <span class="truncate">
                                                    Create team "
                                                    {row.kind === "create"
                                                        ? row.name
                                                        : ""}
                                                    "
                                                </span>
                                            </Show>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Portal>
                </Show>
            </div>
        </Show>
    );
};
