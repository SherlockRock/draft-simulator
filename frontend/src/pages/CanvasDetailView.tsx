import { Component, createEffect, createSignal, onCleanup } from "solid-js";
import { postNewDraft } from "../utils/actions";
import CanvasComponent from "../Canvas";
import ConnectionBanner from "../ConnectionBanner";
import { useNavigate, useParams } from "@solidjs/router";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { Viewport } from "../utils/types";
import toast from "solid-toast";
import { AuthGuard } from "../components/AuthGuard";
import { cardHeight, cardWidth } from "../utils/helpers";
import { useCanvasContext } from "../workflows/CanvasWorkflow";

const CanvasDetailView: Component = () => {
    const params = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { canvas, layoutToggle, setCreateDraftCallback } = useCanvasContext();
    const [viewport, setViewport] = createSignal<Viewport>({ x: 0, y: 0, zoom: 1 });
    let canvasContainerRef: HTMLDivElement | undefined;

    createEffect(() => {
        const canvasData = canvas();
        if (canvasData?.error) {
            const error = canvasData.error;
            if (error && typeof error === "object" && "status" in error) {
                if (error.status === 401 || error.status === 403) {
                    toast.error("You do not have permission to view this canvas.");
                    navigate("/");
                }
            }
        }
    });

    const newDraftMutation = useMutation(() => ({
        mutationFn: (data: {
            name: string;
            picks: string[];
            public: boolean;
            canvas_id: string;
            positionX: number;
            positionY: number;
        }) => postNewDraft(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Successfully created new draft!");
        },
        onError: (error) => {
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const createNewDraft = () => {
        if (canvasContainerRef) {
            const vp = viewport();
            const canvasRect = canvasContainerRef.getBoundingClientRect();
            const currentHeight = cardHeight(layoutToggle());
            const currentWidth = cardWidth(layoutToggle());
            const centerWorldX = vp.x + canvasRect.width / 2 / vp.zoom;
            const centerWorldY = vp.y + canvasRect.height / 2 / vp.zoom;

            const positionX = centerWorldX - currentWidth / 2;
            const positionY = centerWorldY - currentHeight / 2;

            newDraftMutation.mutate({
                name: "New Draft",
                picks: Array(20).fill(""),
                public: false,
                canvas_id: params.id,
                positionX,
                positionY
            });
        }
    };

    // Set the create draft callback for the workflow to use
    createEffect(() => {
        setCreateDraftCallback(() => createNewDraft);

        onCleanup(() => {
            setCreateDraftCallback(null);
        });
    });

    return (
        <AuthGuard requireAuth={true}>
            <div ref={canvasContainerRef} class="flex-1 overflow-hidden">
                <ConnectionBanner />
                <CanvasComponent
                    canvasData={canvas()}
                    isLoading={canvas.loading}
                    isError={canvas.error !== undefined}
                    error={canvas.error}
                    refetch={() => {}}
                    isFetching={canvas.loading}
                    layoutToggle={layoutToggle}
                    setLayoutToggle={() => {}}
                    viewport={viewport}
                    setViewport={setViewport}
                />
            </div>
        </AuthGuard>
    );
};

export default CanvasDetailView;
