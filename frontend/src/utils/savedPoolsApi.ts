import type {
    CreateSavedPoolPayload,
    SavedPool,
    UpdateSavedPoolPayload
} from "@draft-sim/shared-types";
import { fetchWithRefresh } from "./apiClient";

const API_BASE = import.meta.env.VITE_API_URL || "";

export async function fetchSavedPools(): Promise<SavedPool[]> {
    const response = await fetchWithRefresh(`${API_BASE}/api/saved-pools`, {
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to fetch saved pools");
    return response.json();
}

export async function fetchSavedPool(id: string): Promise<SavedPool> {
    const response = await fetchWithRefresh(`${API_BASE}/api/saved-pools/${id}`, {
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to fetch saved pool");
    return response.json();
}

export async function createSavedPool(data: CreateSavedPoolPayload): Promise<SavedPool> {
    const response = await fetchWithRefresh(`${API_BASE}/api/saved-pools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("Failed to create saved pool");
    return response.json();
}

export async function updateSavedPool(
    id: string,
    data: UpdateSavedPoolPayload
): Promise<SavedPool> {
    const response = await fetchWithRefresh(`${API_BASE}/api/saved-pools/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("Failed to update saved pool");
    return response.json();
}

export async function deleteSavedPool(id: string): Promise<{ success?: boolean }> {
    const response = await fetchWithRefresh(`${API_BASE}/api/saved-pools/${id}`, {
        method: "DELETE",
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to delete saved pool");
    return response.json();
}
