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
        () => (user() ? true : null),
        () => fetchCanvasList()
    );

    createEffect(async () => {
        // Wait for auth to resolve before making any decisions
        // user accessor has isLoading property added via Object.defineProperty
        if ((user as unknown as { isLoading?: boolean }).isLoading) return;

        if (user()) {
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
