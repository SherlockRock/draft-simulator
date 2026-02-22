import { Component, createEffect, createResource } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useUser } from "../userProvider";
import { fetchCanvasList, createCanvas } from "../utils/actions";
import {
    hasLocalCanvas,
    createEmptyLocalCanvas,
    saveLocalCanvas
} from "../utils/localCanvasStore";

const CanvasEntryRedirect: Component = () => {
    const navigate = useNavigate();
    const context = useUser();
    const [user] = context();

    // For signed-in users, fetch their canvas list (already sorted by updatedAt DESC)
    const [canvasList] = createResource(
        () => {
            // Only fetch when we know user is signed in
            // user() returns undefined while loading, null/user object when resolved
            const u = user();
            // Check if auth query has settled (not undefined = resolved)
            const hasSettled =
                u !== undefined || (user as unknown as { isError?: boolean }).isError;
            if (!hasSettled) return null; // Don't fetch yet
            return u ? true : null; // Fetch only if signed in
        },
        () => fetchCanvasList()
    );

    createEffect(async () => {
        // Track user() to make the effect reactive to auth state changes
        const currentUser = user();

        // Check if auth is still loading (undefined = loading, null = not signed in)
        // Also check isError for failed auth queries
        const isError = (user as unknown as { isError?: boolean }).isError;
        if (currentUser === undefined && !isError) return;

        if (currentUser) {
            // Signed-in user: wait for canvas list to load
            const list = canvasList();
            if (list === undefined) return; // still loading

            if (list.length > 0) {
                // Navigate to most recently updated canvas (first in list)
                navigate(`/canvas/${list[0].id}`, { replace: true });
            } else {
                // No canvases exist — create a default one
                try {
                    const result = await createCanvas({ name: "My Canvas" });
                    navigate(`/canvas/${result.canvas.id}`, { replace: true });
                } catch {
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
