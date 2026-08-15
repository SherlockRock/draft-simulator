import { createStore, produce } from "solid-js/store";
import { annotationLockChangedSchema } from "./presence";

// Remote annotation holders keyed by annotationId. Like remote viewports,
// this state is extracted from the provider so quiet event validation,
// per-canvas scoping, self filtering, snapshot replacement and reset remain
// unit-testable. Removals use produce/delete because keyed reconcile does not
// reliably shrink under Solid's server build used by vitest.
export function createAnnotationLockTracker(selfId: () => string | undefined) {
    const [locks, setLocks] = createStore<Record<string, string>>({});

    return {
        lockedBy(annotationId: string): string | undefined {
            return locks[annotationId];
        },

        handleLockChanged(rawData: unknown, canvasId: string) {
            const result = annotationLockChangedSchema.safeParse(rawData);
            if (!result.success) return;
            const change = result.data;
            if (change.canvasId !== canvasId) return;
            if (change.userId === selfId()) return;

            if (change.userId === null) {
                setLocks(
                    produce((draft) => {
                        delete draft[change.annotationId];
                    })
                );
                return;
            }

            setLocks(change.annotationId, change.userId);
        },

        handleSnapshot(snapshotLocks: { annotationId: string; userId: string }[]) {
            setLocks(
                produce((draft) => {
                    for (const key of Object.keys(draft)) delete draft[key];
                    for (const lock of snapshotLocks) {
                        if (lock.userId !== selfId()) {
                            draft[lock.annotationId] = lock.userId;
                        }
                    }
                })
            );
        },

        reset() {
            setLocks(
                produce((draft) => {
                    for (const key of Object.keys(draft)) delete draft[key];
                })
            );
        }
    };
}
