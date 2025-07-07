export const BASE_URL =
    import.meta.env.VITE_ENVIRONMENT === "production"
        ? `${import.meta.env.VITE_API_URL}/api`
        : "/api";

export const fetchDraft = async (id: string): Promise<any> => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET"
    });
    const hold = await res.json();
    return hold;
};

export const postNewDraft = async (data: { name: string; public: boolean }) => {
    const res = await fetch(`${BASE_URL}/drafts`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    const hold = await res.json();
    return hold;
};

export const fetchDraftList = async () => {
    const res = await fetch(`${BASE_URL}/drafts/dropdown`);
    return await res.json();
};

export const fetchDefaultDraft = async (id: string | null) => {
    if (!id) return null;
    const res = await fetch(`${BASE_URL}/drafts/${id}`);
    return await res.json();
};

export const editDraft = async (
    id: string,
    data: { name?: string; public?: boolean }
) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    return await res.json();
};

export const deleteDraft = async (id: string) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "DELETE"
    });
    return await res.json();
};

export const generateShareLink = async (draftId: string) => {
    const res = await fetch(`${BASE_URL}/shares/${draftId}/generate-link`, {
        method: "POST",
        credentials: "include"
    });
    const { shareLink } = await res.json();
    return shareLink;
};

// need to handle all cases where res.ok is false

export const fetchUserDetails = async () => {
    const refresh = await fetch(`${BASE_URL}/refresh-token`, {
        method: "GET",
        credentials: "include"
    });
    if (refresh.ok) {
        const hold = await refresh.json();
        return hold.user;
    }
    return undefined;
};

export const handleRevoke = async () => {
    fetch(`${BASE_URL}/revoke/`, {
        method: "GET"
    });
};

export const handleLogin = () => {
    window.location.href = `${BASE_URL}/auth/google`;
};
