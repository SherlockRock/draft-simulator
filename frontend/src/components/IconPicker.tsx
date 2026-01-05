import { createSignal, For, Show } from "solid-js";
import { Dialog } from "./Dialog";
import { champions } from "../utils/constants";

interface IconPickerProps {
    isOpen: () => boolean;
    onClose: () => void;
    onSelect: (icon: string) => void;
    currentIcon?: string;
}

// Common emojis for selection
const EMOJI_OPTIONS = [
    "⚔️",
    "🛡️",
    "🏹",
    "🗡️",
    "🪓",
    "🔱",
    "⚡",
    "🔥",
    "❄️",
    "💧",
    "🌟",
    "✨",
    "💫",
    "🌙",
    "☀️",
    "🌈",
    "☁️",
    "💨",
    "🌊",
    "🌋",
    "👑",
    "💎",
    "🏆",
    "🎯",
    "🎮",
    "🎲",
    "🎭",
    "🎨",
    "🎪",
    "🎬",
    "🦁",
    "🐉",
    "🦅",
    "🐺",
    "🐯",
    "🦈",
    "🦂",
    "🐍",
    "🕷️",
    "🦇",
    "💀",
    "👻",
    "👹",
    "👺",
    "🤖",
    "👽",
    "🧙",
    "🧚",
    "🧛",
    "🧟",
    "🐲",
    "🦖",
    "🦕",
    "🐙",
    "🦑",
    "🦎",
    "🐢",
    "🦀",
    "🦞",
    "🦐",
    "⭐",
    "🌠",
    "💥",
    "🔆",
    "🌌",
    "🌃",
    "🌆",
    "🏔️",
    "🗻",
    "🏰",
    "🗿",
    "🗝️",
    "📜",
    "📖",
    "🔮",
    "🪄",
    "💊",
    "🧪",
    "⚗️",
    "🔬",
    "🧬",
    "🦴",
    "🧿",
    "📿",
    "🎃",
    "👁️",
    "🧠",
    "❤️",
    "💙",
    "💚",
    "💛",
    "💜",
    "🖤",
    "🤍",
    "🧡",
    "🍃",
    "🌿",
    "🍀",
    "🌺",
    "🌸",
    "🌼",
    "🥀",
    "🪴"
];

export const IconPicker = (props: IconPickerProps) => {
    const [activeTab, setActiveTab] = createSignal<"champions" | "emojis">("champions");

    const handleChampionSelect = (index: number) => {
        props.onSelect(index.toString());
        props.onClose();
    };

    const handleEmojiSelect = (emoji: string) => {
        props.onSelect(emoji);
        props.onClose();
    };

    const handleClearIcon = () => {
        props.onSelect("");
        props.onClose();
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="w-[90vw] max-w-4xl">
                    <div class="mb-4 flex items-center justify-between">
                        <h2 class="text-xl font-bold text-slate-50">Select Icon</h2>
                        <button
                            onClick={handleClearIcon}
                            class="rounded-md bg-slate-600 px-3 py-1 text-sm font-medium text-slate-200 hover:bg-slate-500"
                        >
                            Clear Icon
                        </button>
                    </div>

                    {/* Tabs */}
                    <div class="mb-4 flex gap-2 border-b border-slate-600">
                        <button
                            onClick={() => setActiveTab("champions")}
                            class={`px-4 py-2 text-sm font-medium transition-colors ${
                                activeTab() === "champions"
                                    ? "border-b-2 border-teal-500 text-teal-400"
                                    : "text-slate-400 hover:text-slate-300"
                            }`}
                        >
                            Champions
                        </button>
                        <button
                            onClick={() => setActiveTab("emojis")}
                            class={`px-4 py-2 text-sm font-medium transition-colors ${
                                activeTab() === "emojis"
                                    ? "border-b-2 border-teal-500 text-teal-400"
                                    : "text-slate-400 hover:text-slate-300"
                            }`}
                        >
                            Emojis
                        </button>
                    </div>

                    {/* Content */}
                    <div class="max-h-[60vh] overflow-y-auto overflow-x-hidden">
                        <Show when={activeTab() === "champions"}>
                            <div class="grid grid-cols-8 gap-2 p-2 sm:grid-cols-10 md:grid-cols-12">
                                <For each={champions}>
                                    {(champion, index) => (
                                        <button
                                            onClick={() => handleChampionSelect(index())}
                                            class={`group relative aspect-square overflow-hidden rounded border-2 transition-all hover:scale-105 ${
                                                props.currentIcon === index().toString()
                                                    ? "border-teal-400 ring-2 ring-teal-400"
                                                    : "border-slate-600 hover:border-teal-500"
                                            }`}
                                            title={champion.name}
                                        >
                                            <img
                                                src={champion.img}
                                                alt={champion.name}
                                                class="h-full w-full object-cover"
                                            />
                                            <div class="absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 transition-opacity group-hover:opacity-100">
                                                <span class="text-xs text-white">
                                                    {champion.name}
                                                </span>
                                            </div>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>

                        <Show when={activeTab() === "emojis"}>
                            <div class="grid grid-cols-8 gap-2 p-2 sm:grid-cols-10 md:grid-cols-12">
                                <For each={EMOJI_OPTIONS}>
                                    {(emoji) => (
                                        <button
                                            onClick={() => handleEmojiSelect(emoji)}
                                            class={`flex aspect-square items-center justify-center rounded border-2 text-3xl transition-all hover:scale-105 ${
                                                props.currentIcon === emoji
                                                    ? "border-teal-400 bg-slate-700 ring-2 ring-teal-400"
                                                    : "border-slate-600 bg-slate-800 hover:border-teal-500 hover:bg-slate-700"
                                            }`}
                                        >
                                            {emoji}
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>

                    <div class="mt-4 flex justify-end">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            }
        />
    );
};
