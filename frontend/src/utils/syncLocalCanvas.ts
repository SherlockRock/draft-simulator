import { getLocalCanvas, clearLocalCanvas } from "./localCanvasStore";
import { createCanvas, postNewDraft, createCanvasGroup, updateCanvasGroup, updateCanvasDraft, createConnection, updateCanvasViewport } from "./actions";

export const syncLocalCanvasToServer = async (): Promise<string | null> => {
    const local = getLocalCanvas();
    if (!local) return null;

    // Step 1: Create the canvas
    const canvasResult = await createCanvas({
        name: local.name,
        description: local.description || undefined,
        icon: local.icon || undefined
    });
    const canvasId = canvasResult.canvas.id;

    // ID remapping: tempId -> serverId
    const draftIdMap = new Map<string, string>();
    const groupIdMap = new Map<string, string>();

    // Step 2: Save viewport
    await updateCanvasViewport({ canvasId, viewport: local.viewport });

    // Step 3: Create groups first (drafts reference groups)
    for (const group of local.groups) {
        const result = await createCanvasGroup({
            canvasId,
            name: group.name,
            positionX: group.positionX,
            positionY: group.positionY
        });
        groupIdMap.set(group.id, result.group.id);

        // Set width/height if they were customized
        if (group.width != null || group.height != null) {
            await updateCanvasGroup({
                canvasId,
                groupId: result.group.id,
                width: group.width,
                height: group.height
            });
        }
    }

    // Step 3: Create drafts
    for (const draft of local.drafts) {
        const result = await postNewDraft({
            name: draft.Draft.name,
            picks: draft.Draft.picks,
            public: false,
            canvas_id: canvasId,
            positionX: draft.positionX,
            positionY: draft.positionY
        });
        draftIdMap.set(draft.Draft.id, result.id);

        // If draft was in a group, assign it
        if (draft.group_id) {
            const serverGroupId = groupIdMap.get(draft.group_id);
            if (serverGroupId) {
                await updateCanvasDraft({
                    canvasId,
                    draftId: result.id,
                    group_id: serverGroupId
                });
            }
        }
    }

    // Step 4: Create connections with remapped IDs
    for (const conn of local.connections) {
        const remapEndpoint = (e: any) => {
            if ("group_id" in e && e.group_id) {
                return { groupId: groupIdMap.get(e.group_id) ?? e.group_id, anchorType: e.anchor_type };
            }
            return { draftId: draftIdMap.get(e.draft_id) ?? e.draft_id, anchorType: e.anchor_type };
        };

        await createConnection({
            canvasId,
            sourceDraftIds: conn.source_draft_ids.map(remapEndpoint),
            targetDraftIds: conn.target_draft_ids.map(remapEndpoint),
            style: conn.style,
            vertices: conn.vertices
        });
    }

    // Step 5: Clear local storage
    clearLocalCanvas();

    return canvasId;
};
