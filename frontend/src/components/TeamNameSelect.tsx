import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Plus, RotateCcw } from "lucide-solid";
import { toast } from "solid-toast";
import type { ManagedTeamRow, Team, TeamListRow } from "@draft-sim/shared-types";
import { pickerRows, type PickerRow } from "../utils/teamPicker";
import { bulkTeams, createTeam } from "../utils/actions";
import { createDropdownKeyboard } from "../utils/useDropdownKeyboard";

type TeamNameSelectProps = {
    /** Current display name (entity name when linked, else free text). */
    value: string;
    /** Linked team id, or null when the name is free text. */
    teamId: string | null;
    /** The teams to autocomplete against (owned, imported, and linked on this canvas). */
    teams: TeamListRow[];
    /** Archived pickup teams of the user's that can be restored from the picker. */
    archivedOwned?: ManagedTeamRow[];
    /** Disable entity linking (local/anonymous canvases): plain text input. */
    disabled?: boolean;
    placeholder?: string;
    onChange: (name: string, teamId: string | null) => void;
    /** Called after a new team is created so the parent can refresh its list. */
    onCreated?: (team: Team) => void;
    /** Called after an archived team is restored so the parent can refresh its lists. */
    onRestored?: (team: ManagedTeamRow) => void;
};

const rowText = (row: PickerRow) => {
    if (row.kind === "team") return row.label;
    if (row.kind === "restore") return `Restore archived "${row.label}" and link it`;
    return `Create team "${row.name}"`;
};

const inputClass =
    "w-full select-text rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none";

export const TeamNameSelect = (props: TeamNameSelectProps) => {
    const [open, setOpen] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
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

    const rows = createMemo<PickerRow[]>(() =>
        pickerRows(props.value, props.teams, {
            archivedOwned: props.archivedOwned ?? []
        })
    );

    const selectRow = async (row: PickerRow | undefined) => {
        if (!row) return;
        if (row.kind === "team") {
            props.onChange(row.team.name, row.team.id);
            setOpen(false);
            return;
        }
        if (busy()) return;
        setBusy(true);
        try {
            if (row.kind === "create") {
                const team = await createTeam(row.name);
                props.onCreated?.(team);
                props.onChange(team.name, team.id);
            } else {
                const result = await bulkTeams("restore", [row.team.id]);
                if (!result.ids.includes(row.team.id)) {
                    toast.error("Could not restore that team");
                    return;
                }
                props.onRestored?.(row.team);
                props.onChange(row.team.name, row.team.id);
            }
            setOpen(false);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? `Failed to ${row.kind === "create" ? "create" : "restore"} team: ${error.message}`
                    : `Failed to ${row.kind === "create" ? "create" : "restore"} team`
            );
        } finally {
            setBusy(false);
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
                                            <Show when={row.kind === "restore"}>
                                                <RotateCcw
                                                    size={14}
                                                    class="shrink-0 text-darius-purple-bright"
                                                />
                                            </Show>
                                            <Show when={row.kind === "create"}>
                                                <Plus
                                                    size={14}
                                                    class="shrink-0 text-darius-purple-bright"
                                                />
                                            </Show>
                                            <span class="truncate">{rowText(row)}</span>
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
