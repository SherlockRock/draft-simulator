const BASE_URL =
    import.meta.env.ENVIRONMENT === "production"
        ? import.meta.env.VITE_API_URL // e.g., https://your-backend.onrender.com
        : "/api"; // use proxy during development
console.log(BASE_URL);

export const fetchDraft = async (id: string): Promise<any> => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET"
    });
    const hold = await res.json();
    return hold;
};

export const postNewDraft = async () => {
    const res = await fetch(`${BASE_URL}/drafts`, {
        method: "POST"
    });
    const hold = await res.json();
    return hold;
};

export const fetchDraftList = async () => {
    const res = await fetch(`${BASE_URL}/drafts`);
    return await res.json();
};

export const fetchUserDetails = async () => {
    const refresh = await fetch(`${BASE_URL}/refresh-token/`, {
        method: "GET",
        credentials: "include"
    });
    if (refresh.ok) {
        const hold = await refresh.json();
        return hold.user;
    }
    return undefined;
};
// need to handle all cases where res.ok is false
export const deleteDraft = async (id: string) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "DELETE"
    });
    return await res.json();
};

export const handleRevoke = async () => {
    fetch(`${BASE_URL}/api/revoke/`, {
        method: "GET"
    });
};
