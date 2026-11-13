import { Component, JSX, Show } from "solid-js";

// A titled card: header (title, region, count, actions) over its rows.
export const TeamsGroup: Component<{
    title: string;
    region?: string;
    countLabel?: string;
    leading?: JSX.Element;
    actions?: JSX.Element;
    children: JSX.Element;
}> = (props) => (
    <section class="mb-6 rounded-lg border border-darius-border bg-darius-card">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            {props.leading}
            <h2 class="min-w-0 truncate text-lg font-semibold text-darius-text-primary">
                {props.title}
            </h2>
            <Show when={props.region}>
                <span class="rounded bg-darius-card-hover px-1.5 py-0.5 text-xs font-medium text-darius-text-secondary">
                    {props.region}
                </span>
            </Show>
            <Show when={props.countLabel}>
                <span class="text-sm text-darius-text-secondary">{props.countLabel}</span>
            </Show>
            <div class="ml-auto flex flex-wrap items-center gap-2">{props.actions}</div>
        </header>
        {props.children}
    </section>
);
