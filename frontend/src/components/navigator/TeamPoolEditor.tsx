import { Component, For, createSignal } from "solid-js";
import type { Role, RolePoolMap } from "@draft-sim/shared-types";
import { ROLES } from "../../utils/championRoles";
import { RolePoolAccordion } from "./RolePoolAccordion";

interface TeamPoolEditorProps {
    teamColor: "blue" | "red";
    teamLabel: string;
    displayPool: () => RolePoolMap;
    onDisplayPoolChange: (next: RolePoolMap) => void;
}

export const TeamPoolEditor: Component<TeamPoolEditorProps> = (props) => {
    const [openRoles, setOpenRoles] = createSignal<Set<Role>>(new Set<Role>(["top"]));

    const toggleOpen = (role: Role) => {
        setOpenRoles((prev) => {
            const next = new Set(prev);
            if (next.has(role)) next.delete(role);
            else next.add(role);
            return next;
        });
    };

    const setRoleChampions = (role: Role, championIds: string[]) => {
        props.onDisplayPoolChange({
            ...props.displayPool(),
            [role]: championIds
        });
    };

    const totalSelected = () =>
        ROLES.reduce((sum, role) => sum + props.displayPool()[role].length, 0);

    const headerClass =
        props.teamColor === "blue"
            ? "text-blue-300 border-b-blue-500/40"
            : "text-red-300 border-b-red-500/40";

    return (
        <div class="flex flex-col gap-3">
            <div class={`flex items-center justify-between border-b pb-2 ${headerClass}`}>
                <h2 class="text-lg font-semibold">{props.teamLabel}</h2>
                <span class="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300">
                    {totalSelected()} total
                </span>
            </div>

            <div class="flex flex-col gap-2">
                <For each={ROLES}>
                    {(role) => (
                        <RolePoolAccordion
                            role={role}
                            teamColor={props.teamColor}
                            isOpen={openRoles().has(role)}
                            onToggleOpen={() => toggleOpen(role)}
                            selectedChampionIds={() => props.displayPool()[role]}
                            onSelectionChange={(ids) => setRoleChampions(role, ids)}
                        />
                    )}
                </For>
            </div>
        </div>
    );
};
