import { Component, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { fetchCanvasList, createCanvas, fetchUserDetails } from "../utils/actions";
import {
    hasLocalCanvas,
    createEmptyLocalCanvas,
    saveLocalCanvas
} from "../utils/localCanvasStore";
import { useCanvasContext } from "../contexts/CanvasContext";

const CanvasEntryRedirect: Component = () => {
    const navigate = useNavigate();
    const { refetchCanvasList } = useCanvasContext();

    // Use useQuery directly to get proper reactivity for isLoading/isError
    // This shares the cache with UserProvider's query via the same key
    const userQuery = useQuery(() => ({
        queryKey: ["user"],
        queryFn: fetchUserDetails,
        staleTime: 1000 * 60 * 60 * 24,
        retry: false
    }));

    // For signed-in users, fetch their canvas list (already sorted by updatedAt DESC)
    const canvasListQuery = useQuery(() => ({
        queryKey: ["canvasList"],
        queryFn: fetchCanvasList,
        // Only fetch when user is confirmed signed in
        enabled: !userQuery.isLoading && !userQuery.isError && !!userQuery.data,
        // Always refetch on mount — stale cache may lack canvases created last visit
        staleTime: 0
    }));

    let isCreating = false;

    createEffect(async () => {
        // Track reactive query state - these are signals in TanStack Solid Query
        const isLoading = userQuery.isLoading;
        const isError = userQuery.isError;
        const currentUser = userQuery.data;

        // Wait for auth to settle
        if (isLoading) return;

        if (currentUser && !isError) {
            // Wait for fresh data — stale cache may show empty list on remount
            if (canvasListQuery.isFetching) return;
            const list = canvasListQuery.data;

            if (list && list.length > 0) {
                // Navigate to most recently updated canvas (first in list)
                navigate(`/canvas/${list[0].id}`, { replace: true });
            } else {
                // No canvases exist — create a default one
                if (isCreating) return;
                isCreating = true;
                try {
                    const result = await createCanvas({ name: "My Canvas" });
                    // Refresh parent's canvas list so dropdown shows the new canvas
                    refetchCanvasList();
                    navigate(`/canvas/${result.canvas.id}`, { replace: true });
                } catch {
                    isCreating = false;
                    // If creation fails, fall back to dashboard
                    navigate("/canvas/dashboard", { replace: true });
                }
            }
        } else {
            // Anonymous user
            if (!hasLocalCanvas()) {
                const local = createEmptyLocalCanvas("My Canvas");
                saveLocalCanvas(local);
            }
            navigate("/canvas/local", { replace: true });
        }
    });

    // Minimal loading state while resolving
    return (
        <div class="flex flex-1 items-center justify-center bg-slate-900">
            <div class="text-slate-400">Loading canvas...</div>
        </div>
    );
};

export default CanvasEntryRedirect;
