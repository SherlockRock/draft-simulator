import { Component, For } from "solid-js";
import { champions } from "../utils/constants";

interface DisabledChampionsReadOnlyProps {
    championIds: string[];
    label?: string;
}

export const DisabledChampionsReadOnly: Component<DisabledChampionsReadOnlyProps> = (
    props
) => {
    return (
        <div>
            <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                {props.label ?? "Disabled Champions (locked)"}
            </label>
            <div class="grid grid-cols-8 gap-1.5 rounded-md border border-darius-border bg-darius-card-hover/50 p-2">
                <For each={props.championIds}>
                    {(id) => {
                        const champ = champions[parseInt(id)];
                        if (!champ) return null;
                        return (
                            <div
                                class="relative aspect-square overflow-hidden rounded border border-red-700"
                                title={champ.name}
                            >
                                <img
                                    src={champ.img}
                                    alt={champ.name}
                                    class="h-full w-full object-cover opacity-50"
                                />
                            </div>
                        );
                    }}
                </For>
            </div>
        </div>
    );
};
