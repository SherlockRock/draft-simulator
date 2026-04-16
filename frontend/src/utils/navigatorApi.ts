import type { NavigatorSessionData } from "../contexts/NavigatorContext";
import { fetchWithRefresh } from "./apiClient";

const API_BASE = import.meta.env.VITE_API_URL || "";

export async function fetchNavigatorSessions(): Promise<NavigatorSessionData[]> {
    const response = await fetchWithRefresh(`${API_BASE}/api/navigator`, {
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to fetch sessions");
    return response.json();
}

export async function createNavigatorSession(data: {
    our_side: "blue" | "red";
    display_pool: string[];
    search_pool?: string[];
}): Promise<NavigatorSessionData> {
    const response = await fetchWithRefresh(`${API_BASE}/api/navigator`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("Failed to create session");
    return response.json();
}

export async function fetchNavigatorSession(
    id: string
): Promise<NavigatorSessionData> {
    const response = await fetchWithRefresh(`${API_BASE}/api/navigator/${id}`, {
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to fetch session");
    return response.json();
}

export async function updateNavigatorSession(
    id: string,
    data: Record<string, string | string[] | boolean | null>
): Promise<NavigatorSessionData> {
    const response = await fetchWithRefresh(`${API_BASE}/api/navigator/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("Failed to update session");
    return response.json();
}

export async function deleteNavigatorSession(
    id: string
): Promise<{ success?: boolean }> {
    const response = await fetchWithRefresh(`${API_BASE}/api/navigator/${id}`, {
        method: "DELETE",
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to delete session");
    return response.json();
}
