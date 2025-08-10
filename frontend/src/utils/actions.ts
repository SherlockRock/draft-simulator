export const BASE_URL =
    import.meta.env.VITE_ENVIRONMENT === "production"
        ? `${import.meta.env.VITE_API_URL}/api`
        : "/api";

export const fetchDraft = async (id: string): Promise<any> => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET",
        credentials: "include"
    });
    const hold = await res.json();
    return hold;
};

export const postNewDraft = async (data: { name: string; public: boolean }) => {
    const res = await fetch(`${BASE_URL}/drafts`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    const hold = await res.json();
    return hold;
};

export const fetchDraftList = async () => {
    const res = await fetch(`${BASE_URL}/drafts/dropdown`, {
        method: "GET",
        credentials: "include"
    });
    return await res.json();
};

export const fetchDefaultDraft = async (id: string | null) => {
    if (!id || id === "oauth2callback") return null;
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "GET",
        credentials: "include"
    });
    return await res.json();
};

export const editDraft = async (
    id: string,
    data: { name?: string; public?: boolean }
) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    return await res.json();
};

export const deleteDraft = async (id: string) => {
    const res = await fetch(`${BASE_URL}/drafts/${id}`, {
        method: "DELETE",
        credentials: "include"
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
    const refresh = await fetch(`${BASE_URL}/auth/refresh-token`, {
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
    fetch(`${BASE_URL}/auth/revoke/`, {
        method: "GET",
        credentials: "include"
    });
};

export const handleLogin = () => {
    const googleLoginURL = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${import.meta.env.VITE_GOOGLE_CLIENT_ID}&redirect_uri=${window.location.origin}/oauth2callback&response_type=code&scope=openid%20profile%20email`;
    window.location.href = googleLoginURL;
};

export const handleGoogleLogin = async (code: string) => {
    const res = await fetch(`${BASE_URL}/auth/google/callback`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({ code })
    });
    if (res.ok) {
        const { user } = await res.json();
        return user;
    }
    return undefined;
};
