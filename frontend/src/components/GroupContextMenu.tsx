import { Component } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { buildScoutLink, type ScoutLinkParams } from "../utils/scoutLink";
import { ContextMenuAction } from "../utils/types";
import { ContextMenu } from "./ContextMenu";

type GroupContextMenuProps = {
    position: { x: number; y: number };
    group: CanvasGroup;
    onRename?: () => void;
    onViewSeries?: () => void;
    onArrangeGrid?: () => void;
    onConvertToFree?: () => void;
    onGridSettings?: () => void;
    onGoTo: () => void;
    onDelete: () => void;
    onClose: () => void;
    onScout?: (params: ScoutLinkParams) => void;
};

export const GroupContextMenu: Component<GroupContextMenuProps> = (props) => {
    const actions = (): ContextMenuAction[] => {
        const menuActions: ContextMenuAction[] = [];

        if (props.group.type === "custom") {
            menuActions.push({
                label: "Rename",
                action: () => props.onRename?.()
            });

            if (props.group.metadata.layout !== "grid") {
                menuActions.push({
                    label: "Arrange as grid…",
                    action: () => props.onArrangeGrid?.()
                });
            }

            if (props.group.metadata.layout === "grid") {
                menuActions.push(
                    {
                        label: "Grid settings…",
                        action: () => props.onGridSettings?.()
                    },
                    {
                        label: "Convert to free layout",
                        action: () => props.onConvertToFree?.()
                    }
                );
            }
        }

        if (props.group.type === "series" && props.group.metadata.origin !== "manual") {
            menuActions.push({
                label: "View series",
                action: () => props.onViewSeries?.()
            });
        }

        if (props.group.type === "series") {
            const team1 = props.group.Team1 ?? null;
            const team2 = props.group.Team2 ?? null;
            if (team1 || team2) {
                const link = buildScoutLink(team1, team2);
                const team1Rostered = (team1?.TeamPlayers?.length ?? 0) > 0;
                const team2Rostered = (team2?.TeamPlayers?.length ?? 0) > 0;
                const bothRostered = team1Rostered && team2Rostered;
                const soleName = team1Rostered ? team1?.name : team2?.name;
                // When disabled (no rostered team), don't name a team — soleName
                // would misleadingly fall through to team2.
                const label =
                    link === null
                        ? "Scout team"
                        : bothRostered
                          ? "Scout matchup"
                          : `Scout ${soleName ?? "team"}`;
                menuActions.push({
                    label,
                    disabled: link === null,
                    title:
                        link === null
                            ? "Add players to this team's roster first"
                            : undefined,
                    action: () => {
                        if (link) props.onScout?.(link);
                    }
                });
            }
        }

        menuActions.push(
            { label: "Go to", action: () => props.onGoTo() },
            {
                label: "Delete",
                action: () => props.onDelete(),
                destructive: true
            }
        );

        return menuActions;
    };

    return (
        <ContextMenu
            class="group-context-menu"
            header={props.group.name}
            position={props.position}
            actions={actions()}
            onClose={props.onClose}
        />
    );
};
