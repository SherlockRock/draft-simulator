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
    const res = await fetch(`${BASE_URL}${path}`, {
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
    const res = await fetch(`${BASE_URL}${path}`, {
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
    const res = await fetch(`${BASE_URL}${path}`, {
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
export async function apiDelete<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: "DELETE",
        credentials: "include"
    });
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
    const res = await fetch(`${BASE_URL}${path}`, {
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
