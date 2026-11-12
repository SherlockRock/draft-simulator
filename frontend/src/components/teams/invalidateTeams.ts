import type { QueryClient } from "@tanstack/solid-query";

// Every Teams mutation refreshes the page's own query and the picker list.
export const invalidateTeams = (queryClient: QueryClient) =>
    Promise.all([
        queryClient.invalidateQueries({ queryKey: ["teamsManage"] }),
        queryClient.invalidateQueries({ queryKey: ["teams"] })
    ]);
