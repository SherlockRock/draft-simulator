import { Show, createEffect, createSignal, untrack } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";

interface GroupTeamNamesDialogProps {
    group: () => CanvasGroup | null;
    isOpen: () => boolean;
    onClose: () => void;
    onSave: (metadata: { blueTeamName: string; redTeamName: string }) => void;
}

const TEAM_NAME_INPUT_CLASS =
    "w-full appearance-none rounded border border-darius-border bg-darius-card px-3 py-2 text-sm leading-tight text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright";

export const GroupTeamNamesDialog = (props: GroupTeamNamesDialogProps) => {
    const [blueTeamName, setBlueTeamName] = createSignal("");
    const [redTeamName, setRedTeamName] = createSignal("");

    // Only track the open transition. Group metadata is read untracked so a
    // socket reconcile cannot wipe edits while the dialog remains open.
    createEffect(() => {
        if (!props.isOpen()) return;
        untrack(() => {
            const group = props.group();
            if (!group) return;
            setBlueTeamName(group.metadata.blueTeamName ?? "");
            setRedTeamName(group.metadata.redTeamName ?? "");
        });
    });

    const save = () => {
        // Blank names are legitimate: cards inherit/show the default Team 1 or
        // Team 2 label.
        props.onSave({
            blueTeamName: blueTeamName().trim(),
            redTeamName: redTeamName().trim()
        });
        props.onClose();
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            onConfirm={save}
            shouldConfirmOnTarget={(target) => target instanceof HTMLInputElement}
            body={
                <Show when={props.group()}>
                    <div class="flex w-[420px] flex-col text-darius-text-primary">
                        <h2 class="text-xl font-bold text-darius-text-primary">
                            Set Team Names
                        </h2>
                        <p class="mt-2 text-sm text-darius-text-secondary">
                            Applies to every card in this group. Individual cards can
                            override it.
                        </p>

                        <div class="mt-4 grid grid-cols-2 gap-3">
                            <div>
                                <label
                                    class="mb-2 block text-sm font-medium text-darius-text-secondary"
                                    for="group-team-name-blue"
                                >
                                    Team 1
                                </label>
                                <input
                                    id="group-team-name-blue"
                                    type="text"
                                    value={blueTeamName()}
                                    onInput={(e) =>
                                        setBlueTeamName(e.currentTarget.value)
                                    }
                                    class={TEAM_NAME_INPUT_CLASS}
                                />
                            </div>
                            <div>
                                <label
                                    class="mb-2 block text-sm font-medium text-darius-text-secondary"
                                    for="group-team-name-red"
                                >
                                    Team 2
                                </label>
                                <input
                                    id="group-team-name-red"
                                    type="text"
                                    value={redTeamName()}
                                    onInput={(e) => setRedTeamName(e.currentTarget.value)}
                                    class={TEAM_NAME_INPUT_CLASS}
                                />
                            </div>
                        </div>

                        <div class="mt-6 flex items-center justify-end gap-2 border-t border-darius-border pt-4">
                            <button
                                type="button"
                                onClick={props.onClose}
                                class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                            >
                                <span>Cancel</span>
                                <EscapeKeyHint />
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                class="flex items-center gap-2 rounded-md bg-darius-purple px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-purple-bright"
                            >
                                <span>Save</span>
                                <ReturnKeyHint />
                            </button>
                        </div>
                    </div>
                </Show>
            }
        />
    );
};
