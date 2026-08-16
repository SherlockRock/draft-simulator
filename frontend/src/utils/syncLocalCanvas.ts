import { getLocalCanvas, clearLocalCanvas, isLocalCanvasEmpty } from "./localCanvasStore";
import {
    createCanvas,
    postNewDraft,
    createCanvasGroup,
    updateCanvasGroup,
    updateCanvasDraft,
    createConnection,
    createAnnotation,
    updateCanvasViewport,
    updateCanvasDraftPositions
} from "./actions";
import { CanvasGroup, ConnectionEndpoint } from "./schemas";
import type {
    AnnotationColor,
    AnnotationFontSize,
    CanvasAnnotation,
    CanvasGroupMetadata,
    GroupPositionUpdate
} from "@draft-sim/shared-types";

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
    const rest = { ...metadata };
    delete rest.gameType;
    return rest;
};

/**
 * The `groups[]` payload for sync's parentage pass: one entry per LOCAL group
 * that had a parent, with both ids remapped to their server rows.
 *
 * Pure and exported because `syncLocalCanvasToServer` drives eight network
 * actions end to end and has no harness — this is the cheapest seam that can be
 * tested, in the same spirit as `stripUnsyncableGroupMetadata`.
 *
 * Positions are carried unchanged: the batch route takes them as absolute world
 * targets and they are already what the create wrote, so this pass moves
 * nothing (ADR-0006 — reparenting writes no coordinates).
 */
export const nestedGroupSyncEntries = (
    groups: readonly CanvasGroup[],
    idMap: ReadonlyMap<string, string>
): GroupPositionUpdate[] =>
    groups
        .filter((group) => group.parent_group_id)
        .map((group) => ({
            id: idMap.get(group.id) ?? group.id,
            positionX: group.positionX,
            positionY: group.positionY,
            parentId: idMap.get(group.parent_group_id ?? "") ?? null
        }));

export const annotationSyncEntries = (
    annotations: readonly CanvasAnnotation[],
    groupIdMap: ReadonlyMap<string, string>
): {
    sourceId: string;
    positionX: number;
    positionY: number;
    width: number;
    height: number;
    text: string;
    color: AnnotationColor;
    fontSize: AnnotationFontSize;
    manualWidth: number | null;
    manualHeight: number | null;
    group_id: string | null;
}[] =>
    annotations.map((annotation) => ({
        sourceId: annotation.id,
        positionX: annotation.positionX,
        positionY: annotation.positionY,
        width: annotation.width,
        height: annotation.height,
        text: annotation.text,
        color: annotation.color,
        fontSize: annotation.fontSize,
        manualWidth: annotation.manualWidth ?? null,
        manualHeight: annotation.manualHeight ?? null,
        group_id: annotation.group_id
            ? (groupIdMap.get(annotation.group_id) ?? null)
            : null
    }));

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
    const annotationIdMap = new Map<string, string>();

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

    // Step 3b: Re-parent the nested groups, in ONE batch call.
    //
    // A second pass rather than a parents-first ordering: `createCanvasGroup`
    // does take a `parentId` since 5a-1, so an ordered create would also work —
    // but this needs no ordering guarantee at all, and one request is cheaper
    // than N ordered ones. Reparenting writes no coordinates (ADR-0006), so the
    // positions are the ones already created.
    //
    // ⚠️ This is a new mid-sync failure point: the batch route validates the
    // whole tree at once, and local storage is not cleared until the end, so a
    // 400 here leaves a half-built server canvas AND intact local state. Local
    // parentage is guarded by the same predicate on every write, so a rejection
    // means the tree changed underneath us rather than that it was ever
    // illegal.
    const nestedEntries = nestedGroupSyncEntries(local.groups, groupIdMap);
    if (nestedEntries.length > 0) {
        await updateCanvasDraftPositions({
            canvasId,
            positions: [],
            groups: nestedEntries
        });
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

    // Step 3c: Create annotations after their Groups and before Connections.
    // The annotation id map must be complete before connection endpoint
    // remapping learns about annotation endpoints.
    for (const entry of annotationSyncEntries(local.annotations, groupIdMap)) {
        const created = await createAnnotation({
            canvasId,
            positionX: entry.positionX,
            positionY: entry.positionY,
            width: entry.width,
            height: entry.height,
            manualWidth: entry.manualWidth,
            manualHeight: entry.manualHeight,
            text: entry.text,
            color: entry.color,
            fontSize: entry.fontSize,
            group_id: entry.group_id
        });
        annotationIdMap.set(entry.sourceId, created.annotation.id);
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
            if ("annotation_id" in e) {
                return {
                    annotationId: annotationIdMap.get(e.annotation_id) ?? e.annotation_id,
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
