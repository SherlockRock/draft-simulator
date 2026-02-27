import { JSX, Show } from "solid-js";

export const Dialog = (props: {
    body: JSX.Element;
    isOpen: () => boolean;
    onCancel: () => void;
}) => (
    <Show when={props.isOpen()}>
        <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                if (e.target === e.currentTarget) {
                    props.onCancel();
                }
            }}
            onWheel={(e: WheelEvent) => e.stopPropagation()}
        >
            <div class="rounded-lg bg-slate-800 p-6 shadow-lg">{props.body}</div>
        </div>
    </Show>
);
