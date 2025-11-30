import {
    For,
    onMount,
    onCleanup,
    createSignal,
    createEffect,
    Show,
    createMemo
} from "solid-js";
import { createStore } from "solid-js/store";
import { champions } from "./utils/constants";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import {
    postNewDraft,
    updateCanvasDraftPosition,
    deleteDraftFromCanvas,
    updateCanvasViewport,
    CanvasResposnse,
    updateCanvasName
} from "./utils/actions";
import { useNavigate, useParams } from "@solidjs/router";
import { toast } from "solid-toast";
import { useUser } from "./userProvider";
import { CanvasDraft, draft, Viewport } from "./utils/types";
import { CanvasSelect } from "./components/CanvasSelect";
import { Dialog } from "./components/Dialog";

type cardProps = {
    canvasDraft: CanvasDraft;
    addBox: (fromBox: CanvasDraft) => void;
    deleteBox: (draftId: string) => void;
    handleNameChange: (draftId: string, newName: string) => void;
    handlePickChange: (draftId: string, pickIndex: number, championName: string) => void;
    onBoxMouseDown: (draftId: string, e: MouseEvent) => void;
    layoutToggle: () => boolean;
    setLayoutToggle: (val: boolean) => void;
    viewport: () => Viewport;
};

const CanvasCard = (props: cardProps) => {
    const navigate = useNavigate();
    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };
    const screenPos = () =>
        worldToScreen(props.canvasDraft.positionX, props.canvasDraft.positionY);

    const draftArrayMemo = createMemo(() => {
        return props.layoutToggle()
            ? [
                  ...props.canvasDraft.Draft.picks.slice(0, 3),
                  ...props.canvasDraft.Draft.picks.slice(10, 13),
                  ...props.canvasDraft.Draft.picks.slice(3, 5),
                  ...props.canvasDraft.Draft.picks.slice(13, 15),
                  ...props.canvasDraft.Draft.picks.slice(5, 8),
                  ...props.canvasDraft.Draft.picks.slice(15, 18),
                  ...props.canvasDraft.Draft.picks.slice(8, 10),
                  ...props.canvasDraft.Draft.picks.slice(18, 20)
              ]
            : [
                  ...props.canvasDraft.Draft.picks.slice(0, 5),
                  ...props.canvasDraft.Draft.picks.slice(10, 20),
                  ...props.canvasDraft.Draft.picks.slice(5, 10)
              ];
    });

    return (
        <div
            class="absolute flex flex-col rounded-md border border-slate-500 bg-slate-600 shadow-lg"
            style={{
                left: `${screenPos().x}px`,
                top: `${screenPos().y}px`,
                width: props.layoutToggle() ? "700px" : "350px",
                cursor: "move",
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
            onMouseDown={[props.onBoxMouseDown, props.canvasDraft.Draft.id]}
        >
            <div class="flex items-center justify-between p-1">
                <input
                    type="text"
                    placeholder="Enter Draft Name"
                    value={props.canvasDraft.Draft.name}
                    onInput={(e) =>
                        props.handleNameChange(
                            props.canvasDraft.Draft.id,
                            e.currentTarget.value
                        )
                    }
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                            e.currentTarget.blur();
                        }
                    }}
                    onBlur={(e) => e.currentTarget.blur()}
                    class="w-3/4 bg-transparent font-bold text-slate-50"
                />
                <div class="flex gap-1">
                    <button
                        onClick={() => navigate(`/draft/${props.canvasDraft.Draft.id}`)}
                        class="mr-1 flex h-6 w-6 items-center justify-center rounded bg-cyan-400 hover:bg-cyan-700"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                    <button
                        onClick={() => props.addBox(props.canvasDraft)}
                        class="mr-1 flex h-6 w-6 items-center justify-center rounded bg-green-400 hover:bg-green-700"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                    <button
                        onClick={() => props.deleteBox(props.canvasDraft.Draft.id)}
                        class="flex h-6 w-6 items-center justify-center rounded bg-red-400 hover:bg-red-600"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>
            <div class="mb-2 grid grid-cols-2 gap-1">
                <div class="text-center font-semibold text-blue-400">Blue</div>
                <div class="text-center font-semibold text-red-400">Red</div>
            </div>
            <div
                class={
                    props.layoutToggle()
                        ? "grid grid-flow-col grid-cols-4 grid-rows-5 gap-2 p-2"
                        : "grid grid-flow-col grid-cols-2 grid-rows-10 gap-2 p-2"
                }
            >
                <For each={draftArrayMemo()}>
                    {(pick, index) => (
                        <CanvasSelect
                            index={index}
                            pick={pick}
                            handlePickChange={props.handlePickChange}
                            draft={props.canvasDraft.Draft}
                        />
                    )}
                </For>
            </div>
        </div>
    );
};

const debounce = (func: (...args: any[]) => void, limit: number) => {
    let inDebounce: boolean;
    return function (...args: any[]) {
        if (!inDebounce) {
            func(...args);
            inDebounce = true;
            setTimeout(() => (inDebounce = false), limit);
        }
    };
};

type CanvasComponentProps = {
    canvasData: CanvasResposnse | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    isFetching: boolean;
    refetch: () => void;
    layoutToggle: () => boolean;
    setLayoutToggle: (val: boolean) => void;
    viewport: () => Viewport;
    setViewport: (vp: Viewport) => void;
};

const CanvasComponent = (props: CanvasComponentProps) => {
    const params = useParams();
    const queryClient = useQueryClient();
    const accessor = useUser();
    const socketAccessor = accessor()[2];
    const [canvasDrafts, setCanvasDrafts] = createStore<CanvasDraft[]>([]);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = createSignal(false);
    const [draftToDelete, setDraftToDelete] = createSignal<CanvasDraft | null>(null);
    const [viewportInitialized, setViewportInitialized] = createSignal(false);
    let canvasContainerRef: HTMLDivElement | undefined;

    const updateCanvasNameMutation = useMutation(() => ({
        mutationFn: updateCanvasName,
        onSuccess: (data: { name: string; id: string }) => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Canvas name updated");
            queryClient.setQueryData(["canvas", params.id], (oldData: any) => {
                return { ...oldData, name: data.name };
            });
        },
        onError: (error: Error) => {
            toast.error(`Failed to update canvas name: ${error.message}`);
        }
    }));

    const newDraftMutation = useMutation(() => ({
        mutationFn: (data: {
            name: string;
            picks: string[];
            public: boolean;
            canvas_id: string;
            positionX: number;
            positionY: number;
        }) => {
            return postNewDraft(data);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Successfully created new draft!");
        },
        onError: (error) => {
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const editDraftMutation = useMutation(() => ({
        mutationFn: (data: {
            name: string;
            public: boolean;
            canvas_id: string;
            picks: string[];
        }) => {
            return postNewDraft(data);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Successfully created new draft!");
        },
        onError: (error) => {
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const updatePositionMutation = useMutation(() => ({
        mutationFn: updateCanvasDraftPosition,
        onError: (error: Error) => {
            toast.error(`Failed to save position: ${error.message}`);
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        }
    }));

    const deleteDraftMutation = useMutation(() => ({
        mutationFn: deleteDraftFromCanvas,
        onSuccess: () => {
            setIsDeleteDialogOpen(false);
            setDraftToDelete(null);
            toast.success("Successfully deleted draft");
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Error deleting draft: ${error.message}`);
        }
    }));

    const updateViewportMutation = useMutation(() => ({
        mutationFn: updateCanvasViewport,
        onError: (error: Error) => {
            toast.error(`Error updating view: ${error.message}`);
        }
    }));

    const emitMove = (draftId: string, positionX: number, positionY: number) => {
        socketAccessor().emit("canvasObjectMove", {
            canvasId: params.id,
            draftId,
            positionX,
            positionY
        });
    };

    const debouncedEmitMove = debounce(emitMove, 25);

    createEffect(() => {
        if (props.canvasData && canvasDrafts.length === 0) {
            setCanvasDrafts(props.canvasData.drafts ?? []);
            if (!viewportInitialized()) {
                props.setViewport(
                    props.canvasData.lastViewport ?? { x: 0, y: 0, zoom: 1 }
                );
                setViewportInitialized(true);
            }
            socketAccessor().emit("joinRoom", params.id);
            props.canvasData.drafts.forEach((draft: CanvasDraft) => {
                socketAccessor().emit("joinRoom", draft.Draft.id);
            });
        }
    });

    createEffect(() => {
        socketAccessor().on(
            "canvasUpdate",
            (data: { canvas: { id: string; name: string }; drafts: CanvasDraft[] }) => {
                setCanvasDrafts(data.drafts);
                queryClient.setQueryData(["canvas", params.id], (oldData: any) => {
                    return { ...oldData, name: data.canvas.name };
                });
            }
        );
        socketAccessor().on(
            "draftUpdate",
            (data: { picks: string[]; id: string } | draft) => {
                setCanvasDrafts((cd) => cd.Draft.id === data.id, "Draft", "picks", [
                    ...data.picks
                ]);
            }
        );
        socketAccessor().on(
            "canvasObjectMoved",
            (data: { draftId: string; positionX: number; positionY: number }) => {
                if (dragState().activeBoxId !== data.draftId) {
                    setCanvasDrafts((cd) => cd.Draft.id === data.draftId, {
                        positionX: data.positionX,
                        positionY: data.positionY
                    });
                }
            }
        );
        onCleanup(() => {
            socketAccessor().off("canvasUpdate");
            socketAccessor().off("draftUpdate");
            socketAccessor().off("canvasObjectMoved");
        });
    });

    const handleCanvasNameChange = (newName: string) => {
        if (newName.trim() && newName !== props.canvasData?.name) {
            updateCanvasNameMutation.mutate({
                canvasId: params.id,
                name: newName
            });
        }
    };

    const addBox = (fromBox: CanvasDraft) => {
        newDraftMutation.mutate({
            name: fromBox.Draft.name + " Copy",
            picks: fromBox.Draft.picks,
            public: false,
            canvas_id: params.id,
            positionX: fromBox.positionX + 100,
            positionY: fromBox.positionY + 100
        });
    };

    const deleteBox = (draftId: string) => {
        const draft = canvasDrafts.find((d) => d.Draft.id === draftId);
        if (draft) {
            setDraftToDelete(draft);
            setIsDeleteDialogOpen(true);
        }
    };

    const handlePickChange = (
        draftId: string,
        pickIndex: number,
        championName: string
    ) => {
        const champIndex = champions.findIndex((value) => value.name === championName);
        setCanvasDrafts(
            (cd) => cd.Draft.id === draftId,
            "Draft",
            (Draft) => {
                const holdPicks = [...Draft.picks];
                holdPicks[pickIndex] = champIndex !== -1 ? String(champIndex) : "";
                socketAccessor().emit("newDraft", {
                    picks: holdPicks,
                    id: draftId
                });
                return { ...Draft, picks: holdPicks };
            }
        );
    };

    const handleNameChange = (draftId: string, newName: string) => {
        editDraftMutation.mutate({
            name: newName,
            public: false,
            canvas_id: params.id!,
            picks: []
        });
    };

    const [dragState, setDragState] = createSignal<{
        activeBoxId: string | null;
        offsetX: number;
        offsetY: number;
        isPanning: boolean;
        panStartX: number;
        panStartY: number;
        viewportStartX: number;
        viewportStartY: number;
    }>({
        activeBoxId: null,
        offsetX: 0,
        offsetY: 0,
        isPanning: false,
        panStartX: 0,
        panStartY: 0,
        viewportStartX: 0,
        viewportStartY: 0
    });

    const screenToWorld = (screenX: number, screenY: number) => {
        const vp = props.viewport();
        return {
            x: screenX / vp.zoom + vp.x,
            y: screenY / vp.zoom + vp.y
        };
    };

    const onBoxMouseDown = (draftId: string, e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest("select, button, input")) {
            return;
        }
        e.preventDefault();
        const cd = canvasDrafts.find((b) => b.Draft.id === draftId);
        if (cd) {
            const worldCoords = screenToWorld(e.clientX, e.clientY);
            setDragState({
                activeBoxId: draftId,
                offsetX: worldCoords.x - cd.positionX,
                offsetY: worldCoords.y - cd.positionY,
                isPanning: false,
                panStartX: 0,
                panStartY: 0,
                viewportStartX: 0,
                viewportStartY: 0
            });
        }
    };

    const onBackgroundMouseDown = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
            const vp = props.viewport();
            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
                isPanning: true,
                panStartX: e.clientX,
                panStartY: e.clientY,
                viewportStartX: vp.x,
                viewportStartY: vp.y
            });
        }
    };

    const onBackgroundDoubleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
            e.preventDefault();

            const canvasRect = target.getBoundingClientRect();
            const canvasRelativeX = e.clientX - canvasRect.left;
            const canvasRelativeY = e.clientY - canvasRect.top;
            const vp = props.viewport();
            const worldX = canvasRelativeX / vp.zoom + vp.x;
            const worldY = canvasRelativeY / vp.zoom + vp.y;

            newDraftMutation.mutate({
                name: "New Draft",
                picks: Array(20).fill(""),
                public: false,
                canvas_id: params.id,
                positionX: worldX,
                positionY: worldY
            });
        }
    };

    const debouncedSaveViewport = debounce((viewport: Viewport) => {
        updateViewportMutation.mutate({
            canvasId: params.id,
            viewport
        });
    }, 1000);

    onMount(() => {
        const onWindowMouseMove = (e: MouseEvent) => {
            const state = dragState();

            if (state.isPanning) {
                const deltaX = e.clientX - state.panStartX;
                const deltaY = e.clientY - state.panStartY;
                const vp = props.viewport();

                props.setViewport({
                    ...vp,
                    x: state.viewportStartX - deltaX / vp.zoom,
                    y: state.viewportStartY - deltaY / vp.zoom
                });
                debouncedSaveViewport(vp);
            } else if (state.activeBoxId !== null) {
                const worldCoords = screenToWorld(e.clientX, e.clientY);
                const newX = worldCoords.x - state.offsetX;
                const newY = worldCoords.y - state.offsetY;
                setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                    positionX: newX,
                    positionY: newY
                });
                debouncedEmitMove(state.activeBoxId, newX, newY);
            }
        };

        const onWindowMouseUp = () => {
            const state = dragState();
            if (state.activeBoxId) {
                const finalDraft = canvasDrafts.find(
                    (cd) => cd.Draft.id === state.activeBoxId
                );
                if (finalDraft) {
                    updatePositionMutation.mutate({
                        canvasId: params.id,
                        draftId: state.activeBoxId,
                        positionX: finalDraft.positionX,
                        positionY: finalDraft.positionY
                    });
                }
            }

            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
                isPanning: false,
                panStartX: 0,
                panStartY: 0,
                viewportStartX: 0,
                viewportStartY: 0
            });
        };

        const onWindowWheel = (e: WheelEvent) => {
            const target = e.target as HTMLElement;
            if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
                e.preventDefault();
                const vp = props.viewport();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                const newZoom = Math.max(0.1, Math.min(5, vp.zoom * zoomFactor));

                const mouseWorldBefore = screenToWorld(e.clientX, e.clientY);
                const mouseWorldAfter = screenToWorld(e.clientX, e.clientY);

                props.setViewport({
                    zoom: newZoom,
                    x: vp.x - (mouseWorldAfter.x - mouseWorldBefore.x),
                    y: vp.y - (mouseWorldAfter.y - mouseWorldBefore.y)
                });
            }
        };

        window.addEventListener("mousemove", onWindowMouseMove);
        window.addEventListener("mouseup", onWindowMouseUp);
        window.addEventListener("wheel", onWindowWheel, { passive: false });

        onCleanup(() => {
            window.removeEventListener("mousemove", onWindowMouseMove);
            window.removeEventListener("mouseup", onWindowMouseUp);
            window.removeEventListener("wheel", onWindowWheel);
        });
    });

    const resetViewport = () => {
        props.setViewport({ x: 0, y: 0, zoom: 1 });
    };

    const onDelete = () => {
        if (draftToDelete()) {
            deleteDraftMutation.mutate({
                canvas: params.id,
                draft: draftToDelete()!.Draft.id
            });
        }
    };

    const onCancel = () => {
        setIsDeleteDialogOpen(false);
        setDraftToDelete(null);
    };

    return (
        <Show
            when={!props.isLoading && !props.isError}
            fallback={
                <Show
                    when={props.isError}
                    fallback={
                        <div class="flex h-full w-full items-center justify-center">
                            <div class="text-lg">Loading canvas...</div>
                        </div>
                    }
                >
                    <div class="flex h-full w-full flex-col items-center justify-center gap-4">
                        <div class="text-lg text-red-600">
                            Error loading canvas: {props.error?.message}
                        </div>
                        <button
                            onClick={() => props.refetch()}
                            class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
                        >
                            Retry
                        </button>
                    </div>
                </Show>
            }
        >
            <div class="relative h-full w-full overflow-hidden" ref={canvasContainerRef}>
                <div class="absolute left-4 top-4 z-10 flex gap-2">
                    <input
                        type="text"
                        value={props.canvasData?.name || ""}
                        onInput={(e) => e.currentTarget.value}
                        onBlur={(e) => handleCanvasNameChange(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape") {
                                e.currentTarget.blur();
                            }
                        }}
                        class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-slate-50 shadow focus:border-teal-400 focus:outline-none"
                        placeholder="Canvas Name"
                    />
                    <div class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-slate-50 shadow">
                        Zoom: {Math.round(props.viewport().zoom * 100)}%
                    </div>
                    <button
                        onClick={resetViewport}
                        class="rounded border border-slate-500 bg-teal-700 px-3 py-1.5 text-slate-50 shadow hover:bg-teal-400"
                    >
                        Reset View
                    </button>
                </div>
                <Show when={props.isFetching}>
                    <div class="rounded border bg-blue-100 px-3 py-1 text-sm text-blue-800 shadow">
                        Syncing...
                    </div>
                </Show>
                <div
                    class="canvas-background absolute inset-0 cursor-move bg-slate-700"
                    onMouseDown={onBackgroundMouseDown}
                    onDblClick={onBackgroundDoubleClick}
                />
                <For each={canvasDrafts}>
                    {(cd) => (
                        <CanvasCard
                            canvasDraft={cd}
                            addBox={addBox}
                            deleteBox={deleteBox}
                            handleNameChange={handleNameChange}
                            handlePickChange={handlePickChange}
                            viewport={props.viewport}
                            onBoxMouseDown={onBoxMouseDown}
                            layoutToggle={props.layoutToggle}
                            setLayoutToggle={props.setLayoutToggle}
                        />
                    )}
                </For>
                <Dialog
                    isOpen={isDeleteDialogOpen}
                    onCancel={onCancel}
                    body={
                        <>
                            <h3 class="mb-4 text-lg font-bold text-slate-50">
                                Confirm Deletion
                            </h3>
                            <p class="mb-6 text-slate-200">
                                Are you sure you want to delete the draft "
                                {draftToDelete()?.Draft.name}
                                "?
                            </p>
                            <div class="flex justify-end gap-4">
                                <button
                                    onClick={onCancel}
                                    class="rounded bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={onDelete}
                                    class="rounded bg-red-400 px-4 py-2 text-slate-50 hover:bg-red-600"
                                >
                                    Delete
                                </button>
                            </div>
                        </>
                    }
                />
            </div>
        </Show>
    );
};

export default CanvasComponent;
