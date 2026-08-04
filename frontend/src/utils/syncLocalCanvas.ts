import { getLocalCanvas, clearLocalCanvas, isLocalCanvasEmpty } from "./localCanvasStore";
import {
    createCanvas,
    postNewDraft,
    createCanvasGroup,
    updateCanvasGroup,
    updateCanvasDraft,
    createConnection,
    updateCanvasViewport
} from "./actions";
import { ConnectionEndpoint } from "./schemas";
import type { CanvasGroupMetadata } from "@draft-sim/shared-types";

/**
 * Drops `gameType` from local group metadata on its way to the server.
 *
 * This looks like a bug. It is not — see design D6. Sync creates every local
 * group through `createCanvasGroup`, which hardcodes `type: "custom"`; there is
 * no series path in sync at all. So any gameType here, including one the user
 * deliberately set, would land on the server attached to a CUSTOM group and be
 * counted toward a real team's record, in the database, with no migration
 * guarding it. Tagging works while local; the tag does not survive sync.
 *
 * The information loss mirrors one that already exists: a synced local series
 * becomes a custom group and stops counting regardless. Fixing that belongs to
 * whoever owns local-canvas sync.
 */
export const stripUnsyncableGroupMetadata = (
    metadata: CanvasGroupMetadata
): CanvasGroupMetadata => {
    const { gameType: _gameType, ...rest } = metadata;
    return rest;
};

export const syncLocalCanvasToServer = async (): Promise<string | null> => {
    // Skip sync if canvas is empty (no drafts, no groups, not renamed)
    if (isLocalCanvasEmpty()) return null;

    const local = getLocalCanvas();
    if (!local) return null;

    // Step 1: Create the canvas
    const canvasResult = await createCanvas({
        name: local.name,
        description: local.description || undefined,
        icon: local.icon || undefined,
        cardLayout: local.cardLayout
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

        // Sync width/height and metadata if they were customized. The metadata
        // is stripped first, so a group whose ONLY customization was a gameType
        // correctly sends nothing.
        const syncedMetadata = stripUnsyncableGroupMetadata(group.metadata ?? {});
        const hasSize = group.width != null || group.height != null;
        const hasMetadata = Object.keys(syncedMetadata).length > 0;
        if (hasSize || hasMetadata) {
            await updateCanvasGroup({
                canvasId,
                groupId: result.group.id,
                ...(hasSize && { width: group.width, height: group.height }),
                ...(hasMetadata && { metadata: syncedMetadata })
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

        const serverGroupId = draft.group_id ? groupIdMap.get(draft.group_id) : undefined;
        const team1Name = draft.team1Name?.trim();
        const team2Name = draft.team2Name?.trim();

        if (serverGroupId || team1Name || team2Name) {
            await updateCanvasDraft({
                canvasId,
                draftId: result.id,
                ...(serverGroupId && { group_id: serverGroupId }),
                ...(team1Name && { team1Name }),
                ...(team2Name && { team2Name })
            });
        }
    }

    // Step 4: Create connections with remapped IDs
    for (const conn of local.connections) {
        const remapEndpoint = (e: ConnectionEndpoint) => {
            if ("group_id" in e) {
                return {
                    groupId: groupIdMap.get(e.group_id) ?? e.group_id,
                    anchorType: e.anchor_type
                };
            }
            return {
                draftId: draftIdMap.get(e.draft_id) ?? e.draft_id,
                anchorType: e.anchor_type
            };
        };

        await createConnection({
            canvasId,
            sourceDraftIds: conn.source_draft_ids.map(remapEndpoint),
            targetDraftIds: conn.target_draft_ids.map(remapEndpoint),
            style: conn.style,
            vertices: conn.vertices
        });
    }

    // Step 5: Clear local storage after successful sync
    clearLocalCanvas();

    return canvasId;
};
