import { z } from "zod";
import toast from "solid-toast";

/**
 * Custom error class for API validation failures.
 * Thrown when a response doesn't match the expected schema.
 */
export class ValidationError extends Error {
    public zodError: z.ZodError;

    constructor(zodError: z.ZodError) {
        super("API response validation failed");
        this.name = "ValidationError";
        this.zodError = zodError;
    }
}

const BASE_URL =
    import.meta.env.VITE_ENVIRONMENT === "production"
        ? `${import.meta.env.VITE_API_URL}/api`
        : "/api";

// Deduplicates concurrent refresh attempts so multiple 401s
// don't fire multiple refresh requests.
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
    try {
        const res = await fetch(`${BASE_URL}/auth/refresh-token`, {
            credentials: "include"
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Fetch wrapper that retries once on 401 by refreshing the access token.
 */
async function fetchWithRefresh(url: string, options: RequestInit): Promise<Response> {
    const res = await fetch(url, options);
    if (res.status !== 401) return res;

    if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => {
            refreshPromise = null;
        });
    }

    const refreshed = await refreshPromise;
    if (!refreshed) return res;

    return fetch(url, options);
}

/**
 * Parse and validate API response data against a Zod schema.
 * Shows a toast and throws ValidationError on failure.
 */
function validateResponse<T>(data: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        toast.error("Something went wrong. Please try again.");
        console.error("API validation failed:", result.error.format());
        throw new ValidationError(result.error);
    }
    return result.data;
}

/**
 * Validated GET request.
 */
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await fetchWithRefresh(`${BASE_URL}${path}`, {
        credentials: "include"
    });
    if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    return validateResponse(data, schema);
}

/**
 * Validated POST request.
 */
export async function apiPost<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>
): Promise<T> {
    const res = await fetchWithRefresh(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    return validateResponse(data, schema);
}

/**
 * Validated PUT request.
 */
export async function apiPut<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>
): Promise<T> {
    const res = await fetchWithRefresh(`${BASE_URL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    return validateResponse(data, schema);
}

/**
 * Validated DELETE request.
 */
export async function apiDelete<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown
): Promise<T> {
    const options: RequestInit = {
        method: "DELETE",
        credentials: "include"
    };
    if (body !== undefined) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
    }
    const res = await fetchWithRefresh(`${BASE_URL}${path}`, options);
    if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    return validateResponse(data, schema);
}

/**
 * Validated PATCH request.
 */
export async function apiPatch<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>
): Promise<T> {
    const res = await fetchWithRefresh(`${BASE_URL}${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    return validateResponse(data, schema);
}
