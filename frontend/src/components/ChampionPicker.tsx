import { Component } from "solid-js";

export type ChampionColorState =
    | "picked"
    | "own-team"
    | "other-team"
    | "shared"
    | "neutral";

export interface ChampionPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (championId: string) => void;

    /** Bottom strip label, e.g. "SCENARIO 1 - RB2" or "BLUE PICK 2". */
    contextLabel?: string;

    /** Verb for the Enter hint, e.g. "Pick", "Swap to", "Add branch with". Defaults to "Pick". */
    actionVerb?: string;

    /** Champion IDs that should render dimmed and non-interactive. */
    disabledChampionIds?: Set<string>;

    /** Per-champion coloring override. Called for every visible champion; return "neutral" for default. */
    championColoring?: (championId: string) => ChampionColorState;

    /** Initial role filter. "all" (default) or one of the RoleFilter category keys. */
    initialRole?: "all" | "Top" | "Jungle" | "Mid" | "Bot" | "Support";
}

const ChampionPicker: Component<ChampionPickerProps> = (_props) => {
    // Implementation lands in Tasks 2–6.
    return null;
};

export default ChampionPicker;
