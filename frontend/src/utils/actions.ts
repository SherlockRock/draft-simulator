export const BASE_URL =
    import.meta.env.VITE_ENVIRONMENT === "production"
        ? import.meta.env.VITE_API_URL
        : "/api";

export const fetchDraft = async (id: string): Promise<any> => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET"
    });
    const hold = await res.json();
    console.log(res);
    console.log(hold);
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
    const hold = await res.json();
    console.log(res);
    console.log(hold);
    return hold;
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
    fetch(`${BASE_URL}/revoke/`, {
        method: "GET"
    });
};
