import posthog from "posthog-js";

let initialized = false;

export function initAnalytics(): void {
    const key = import.meta.env.VITE_POSTHOG_KEY;
    const host = import.meta.env.VITE_POSTHOG_HOST;
    if (!key) return;

    posthog.init(key, {
        api_host: host || "https://us.i.posthog.com",
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true
    });
    initialized = true;
}

export function identifyUser(
    userId: string,
    traits: { name?: string; email?: string }
): void {
    if (!initialized) return;
    posthog.identify(userId, traits);
}

export function resetUser(): void {
    if (!initialized) return;
    posthog.reset();
}

export function track(
    event: string,
    properties?: Record<string, unknown>
): void {
    if (!initialized) return;
    posthog.capture(event, properties);
}
