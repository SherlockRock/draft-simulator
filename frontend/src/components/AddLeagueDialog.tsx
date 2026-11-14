import { Component, createEffect, createSignal, For, Show } from "solid-js";
import { useMutation } from "@tanstack/solid-query";
import { SCOUT_REGION_OPTIONS } from "@draft-sim/shared-types";
import { Dialog } from "./Dialog";
import { addEsclubLeague } from "../utils/actions";
import {
    ACCEPTED_LINK_EXAMPLE,
    esclubActionMessage,
    parseEsclubUrl,
    type EsclubActionResult
} from "../utils/esclubSync";

export const AddLeagueDialog: Component<{
    isOpen: boolean;
    onClose: () => void;
    onResult: (result: EsclubActionResult) => void;
}> = (props) => {
    const [url, setUrl] = createSignal("");
    const [region, setRegion] = createSignal("na1");
    const [message, setMessage] = createSignal("");
    const [submitted, setSubmitted] = createSignal(false);

    const mutation = useMutation(() => ({
        mutationFn: addEsclubLeague,
        retry: false,
        onSuccess: (result) => {
            setMessage(esclubActionMessage(result, Date.now()));
            setSubmitted(result.status === 200 || result.status === 202);
            props.onResult(result);
        },
        onError: () => setMessage("Could not add the league. Please try again.")
    }));

    createEffect(() => {
        if (props.isOpen) {
            setUrl("");
            setRegion("na1");
            setMessage("");
            setSubmitted(false);
        }
    });

    const close = () => {
        if (!mutation.isPending) props.onClose();
    };

    const submit = () => {
        if (mutation.isPending || submitted()) return;
        if (!parseEsclubUrl(url())) {
            setMessage(
                esclubActionMessage(
                    {
                        status: 400,
                        body: { code: "INVALID_URL", error: "Invalid URL" }
                    },
                    Date.now()
                )
            );
            return;
        }
        setMessage("");
        mutation.mutate({ url: url().trim(), region: region() });
    };

    return (
        <Dialog
            isOpen={() => props.isOpen}
            onCancel={close}
            onConfirm={submit}
            confirmOnInput
            contentClass="relative max-h-[90vh] overflow-y-auto rounded-lg bg-slate-800 p-6 pr-14 shadow-lg"
            body={
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="add-league-title"
                    class="w-[min(100vw-6rem,28rem)] max-w-full text-slate-50"
                >
                    <h2 id="add-league-title" class="mb-3 text-lg font-bold">
                        Add league
                    </h2>
                    <p id="add-league-links" class="mb-4 text-sm text-slate-200">
                        Only esclub series links are accepted. Use this form:
                        <code class="mt-1 block break-all text-teal-400">
                            {ACCEPTED_LINK_EXAMPLE}
                        </code>
                        Replace &lt;series id&gt; with the series UUID from its link.
                    </p>
                    <label class="mb-4 block text-sm">
                        Series URL
                        <input
                            type="url"
                            value={url()}
                            onInput={(event) => setUrl(event.currentTarget.value)}
                            disabled={mutation.isPending || submitted()}
                            aria-describedby="add-league-links"
                            ref={(element) => queueMicrotask(() => element.focus())}
                            class="mt-1 w-full rounded-md border border-slate-500 bg-slate-700 px-3 py-2 text-slate-50 focus:border-teal-400 focus:outline-none disabled:opacity-50"
                        />
                    </label>
                    <label class="mb-2 block text-sm">
                        Region
                        <select
                            value={region()}
                            onChange={(event) => setRegion(event.currentTarget.value)}
                            disabled={mutation.isPending || submitted()}
                            class="mt-1 w-full rounded-md border border-slate-500 bg-slate-700 px-3 py-2 text-slate-50 focus:border-teal-400 focus:outline-none disabled:opacity-50"
                        >
                            <For each={SCOUT_REGION_OPTIONS}>
                                {(option) => (
                                    <option value={option.value}>{option.label}</option>
                                )}
                            </For>
                        </select>
                    </label>
                    <p class="mb-4 text-xs text-slate-200">
                        Used when this league is first added.
                    </p>
                    <Show when={message()}>
                        <p role="status" class="mb-4 text-sm text-slate-200">
                            {message()}
                        </p>
                    </Show>
                    <div class="flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={close}
                            disabled={mutation.isPending}
                            class="rounded-md border border-slate-500 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                        >
                            {submitted() ? "Done" : "Cancel"}
                        </button>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={mutation.isPending || submitted()}
                            class="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-slate-50 hover:bg-teal-600 disabled:opacity-50"
                        >
                            {mutation.isPending ? "Adding…" : "Add league"}
                        </button>
                    </div>
                </div>
            }
        />
    );
};
