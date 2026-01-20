export interface VersusRoleData {
    role: "blue_captain" | "red_captain" | "spectator";
    participantId: string;
    reclaimToken?: string;
    timestamp: number;
}

const STORAGE_KEY_PREFIX = "versus_role_";

export function saveVersusRole(versusDraftId: string, data: VersusRoleData): void {
    const storageData = {
        ...data,
        timestamp: Date.now()
    };

    try {
        sessionStorage.setItem(
            `${STORAGE_KEY_PREFIX}${versusDraftId}`,
            JSON.stringify(storageData)
        );
    } catch (error) {
        console.error("Failed to save versus role:", error);
    }
}

export function getVersusRole(versusDraftId: string): VersusRoleData | null {
    try {
        const stored = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${versusDraftId}`);

        if (!stored) return null;

        const data = JSON.parse(stored) as VersusRoleData;

        return data;
    } catch (error) {
        console.error("Failed to read versus role:", error);
        return null;
    }
}

export function clearVersusRole(versusDraftId: string): void {
    try {
        sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${versusDraftId}`);
    } catch (error) {
        console.error("Failed to clear versus role:", error);
    }
}
