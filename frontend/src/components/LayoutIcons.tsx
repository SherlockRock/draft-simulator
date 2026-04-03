import type { CardLayout } from "../utils/canvasCardLayout";

interface LayoutIconProps {
    size?: number;
    class?: string;
}

const banColor = "#f87171"; // red-400
const pickColor = "#34d399"; // emerald-400
const slotColor = "#334155"; // slate-700
const bgColor = "#1e293b"; // slate-800
const borderColor = "#475569"; // slate-600

/** Vertical: 2 columns, 5 bans over 5 picks per team */
function VerticalIcon(props: LayoutIconProps) {
    const s = () => props.size ?? 32;
    // Card aspect: 380x600 ≈ 0.63:1
    // Normalized to height=s, width=s*0.63
    return (
        <svg
            width={s()}
            height={s()}
            viewBox="0 0 40 40"
            fill="none"
            class={props.class}
        >
            {/* Left column - Team 1 */}
            {/* Ban accent bar */}
            <rect x="7" y="2" width="1.5" height="16" rx="0.75" fill={banColor} />
            {/* Ban slots — square + name line */}
            {[0, 1, 2, 3, 4].map((i) => (
                <>
                    <rect x="10" y={2.5 + i * 3.2} width="3" height="2.4" rx="0.5" fill={slotColor} />
                    <rect x="14" y={3 + i * 3.2} width="5" height="1.4" rx="0.7" fill={slotColor} />
                </>
            ))}
            {/* Pick accent bar */}
            <rect x="7" y="21" width="1.5" height="17" rx="0.75" fill={pickColor} />
            {/* Pick slots — square + name line */}
            {[0, 1, 2, 3, 4].map((i) => (
                <>
                    <rect x="10" y={21.5 + i * 3.4} width="3" height="2.6" rx="0.5" fill={slotColor} />
                    <rect x="14" y={22.1 + i * 3.4} width="5" height="1.4" rx="0.7" fill={slotColor} />
                </>
            ))}

            {/* Right column - Team 2 */}
            {/* Ban slots — name line + square */}
            {[0, 1, 2, 3, 4].map((i) => (
                <>
                    <rect x="22" y={3 + i * 3.2} width="5" height="1.4" rx="0.7" fill={slotColor} />
                    <rect x="28" y={2.5 + i * 3.2} width="3" height="2.4" rx="0.5" fill={slotColor} />
                </>
            ))}
            {/* Ban accent bar */}
            <rect x="32.5" y="2" width="1.5" height="16" rx="0.75" fill={banColor} />
            {/* Pick slots — name line + square */}
            {[0, 1, 2, 3, 4].map((i) => (
                <>
                    <rect x="22" y={22.1 + i * 3.4} width="5" height="1.4" rx="0.7" fill={slotColor} />
                    <rect x="28" y={21.5 + i * 3.4} width="3" height="2.6" rx="0.5" fill={slotColor} />
                </>
            ))}
            {/* Pick accent bar */}
            <rect x="32.5" y="21" width="1.5" height="17" rx="0.75" fill={pickColor} />
        </svg>
    );
}

/** Horizontal: 4 columns — T1 bans, T1 picks, T2 picks, T2 bans */
function HorizontalIcon(props: LayoutIconProps) {
    const s = () => props.size ?? 32;
    return (
        <svg
            width={s()}
            height={s()}
            viewBox="0 0 40 40"
            fill="none"
            class={props.class}
        >
            {/* 4 columns of 5 slots, with top accent bars */}
            {[0, 1, 2, 3].map((col) => {
                const x = 2 + col * 9.5;
                const isBan = col === 0 || col === 3;
                const isRight = col >= 2;
                const accentColor = isBan ? banColor : pickColor;
                return (
                    <>
                        {/* Top accent bar */}
                        <rect x={x} y="4" width="8" height="1.5" rx="0.75" fill={accentColor} />
                        {/* Slots — square + name line */}
                        {[0, 1, 2, 3, 4].map((row) => (
                            <>
                                <rect x={isRight ? x + 5 : x} y={7.5 + row * 6} width="3" height="3" rx="0.5" fill={slotColor} />
                                <rect x={isRight ? x : x + 3.8} y={8 + row * 6} width="4.2" height="1.4" rx="0.7" fill={slotColor} />
                            </>
                        ))}
                    </>
                );
            })}
        </svg>
    );
}

/** Compact: 2 columns, horizontal ban row on top, 5 picks vertical below */
function CompactIcon(props: LayoutIconProps) {
    const s = () => props.size ?? 32;
    return (
        <svg
            width={s()}
            height={s()}
            viewBox="0 0 40 40"
            fill="none"
            class={props.class}
        >
            {/* Left column - Team 1 */}
            {/* Ban row — horizontal dots */}
            <rect x="3" y="3" width="16" height="1.2" rx="0.6" fill={banColor} />
            {[0, 1, 2, 3, 4].map((i) => (
                <rect x={3.5 + i * 3} y="5.5" width="2.2" height="2.2" rx="0.5" fill={slotColor} />
            ))}
            {/* Pick accent bar */}
            <rect x="3" y="10" width="1.5" height="28" rx="0.75" fill={pickColor} />
            {/* Pick slots — square + name line */}
            {[0, 1, 2, 3, 4].map((i) => (
                <>
                    <rect x="6" y={10.5 + i * 5.6} width="3" height="4" rx="0.5" fill={slotColor} />
                    <rect x="10" y={11.5 + i * 5.6} width="6" height="2" rx="0.7" fill={slotColor} />
                </>
            ))}

            {/* Right column - Team 2 */}
            {/* Ban row — horizontal dots */}
            <rect x="21" y="3" width="16" height="1.2" rx="0.6" fill={banColor} />
            {[0, 1, 2, 3, 4].map((i) => (
                <rect x={21.5 + i * 3} y="5.5" width="2.2" height="2.2" rx="0.5" fill={slotColor} />
            ))}
            {/* Pick accent bar */}
            <rect x="35.5" y="10" width="1.5" height="28" rx="0.75" fill={pickColor} />
            {/* Pick slots — square + name line */}
            {[0, 1, 2, 3, 4].map((i) => (
                <>
                    <rect x="31.5" y={10.5 + i * 5.6} width="3" height="4" rx="0.5" fill={slotColor} />
                    <rect x="24.5" y={11.5 + i * 5.6} width="6" height="2" rx="0.7" fill={slotColor} />
                </>
            ))}
        </svg>
    );
}

/** Wide: 2 columns, wider/taller art slots, bans over picks */
function WideIcon(props: LayoutIconProps) {
    const s = () => props.size ?? 32;
    return (
        <svg
            width={s()}
            height={s()}
            viewBox="0 0 40 40"
            fill="none"
            class={props.class}
        >
            {/* Left column - Team 1 */}
            <rect x="2" y="1" width="1.5" height="17" rx="0.75" fill={banColor} />
            {[0, 1, 2, 3, 4].map((i) => (
                <rect x="5" y={1 + i * 3.4} width="14" height="2.6" rx="0.5" fill={slotColor} />
            ))}
            <rect x="2" y="20.5" width="1.5" height="18.5" rx="0.75" fill={pickColor} />
            {[0, 1, 2, 3, 4].map((i) => (
                <rect x="5" y={20.5 + i * 3.7} width="14" height="2.9" rx="0.5" fill={slotColor} />
            ))}

            {/* Right column - Team 2 */}
            {[0, 1, 2, 3, 4].map((i) => (
                <rect x="21" y={1 + i * 3.4} width="14" height="2.6" rx="0.5" fill={slotColor} />
            ))}
            <rect x="36.5" y="1" width="1.5" height="17" rx="0.75" fill={banColor} />
            {[0, 1, 2, 3, 4].map((i) => (
                <rect x="21" y={20.5 + i * 3.7} width="14" height="2.9" rx="0.5" fill={slotColor} />
            ))}
            <rect x="36.5" y="20.5" width="1.5" height="18.5" rx="0.75" fill={pickColor} />
        </svg>
    );
}

/** Draft Order: 2 columns, 4 sections (3-3-2-2) following ban/pick sequence */
function DraftOrderIcon(props: LayoutIconProps) {
    const s = () => props.size ?? 32;
    // Sections: Bans(3), Picks(3), Bans(2), Picks(2)
    const sections = [
        { count: 3, color: banColor, yStart: 1 },
        { count: 3, color: pickColor, yStart: 12 },
        { count: 2, color: banColor, yStart: 23.5 },
        { count: 2, color: pickColor, yStart: 31.5 }
    ];

    return (
        <svg
            width={s()}
            height={s()}
            viewBox="0 0 40 40"
            fill="none"
            class={props.class}
        >
            {/* Left column - Team 1 */}
            {sections.map((sec) => (
                <>
                    <rect
                        x="7"
                        y={sec.yStart}
                        width="1.5"
                        height={sec.count * 3.2 - 0.8}
                        rx="0.75"
                        fill={sec.color}
                    />
                    {Array.from({ length: sec.count }).map((_, i) => (
                        <>
                            <rect x="10" y={sec.yStart + i * 3.2} width="3" height="2.4" rx="0.5" fill={slotColor} />
                            <rect x="14" y={sec.yStart + 0.5 + i * 3.2} width="5" height="1.4" rx="0.7" fill={slotColor} />
                        </>
                    ))}
                </>
            ))}

            {/* Right column - Team 2 */}
            {sections.map((sec) => (
                <>
                    {Array.from({ length: sec.count }).map((_, i) => (
                        <>
                            <rect x="22" y={sec.yStart + 0.5 + i * 3.2} width="5" height="1.4" rx="0.7" fill={slotColor} />
                            <rect x="28" y={sec.yStart + i * 3.2} width="3" height="2.4" rx="0.5" fill={slotColor} />
                        </>
                    ))}
                    <rect
                        x="32.5"
                        y={sec.yStart}
                        width="1.5"
                        height={sec.count * 3.2 - 0.8}
                        rx="0.75"
                        fill={sec.color}
                    />
                </>
            ))}
        </svg>
    );
}

/** Wide Draft Order: 2 columns, 4 sections (3-3-2-2) with wide art slots */
function WideDraftOrderIcon(props: LayoutIconProps) {
    const s = () => props.size ?? 32;
    const sections = [
        { count: 3, color: banColor, yStart: 1 },
        { count: 3, color: pickColor, yStart: 12 },
        { count: 2, color: banColor, yStart: 23.5 },
        { count: 2, color: pickColor, yStart: 31.5 }
    ];

    return (
        <svg
            width={s()}
            height={s()}
            viewBox="0 0 40 40"
            fill="none"
            class={props.class}
        >
            {/* Left column - Team 1 */}
            {sections.map((sec) => (
                <>
                    <rect
                        x="2"
                        y={sec.yStart}
                        width="1.5"
                        height={sec.count * 3.4 - 0.8}
                        rx="0.75"
                        fill={sec.color}
                    />
                    {Array.from({ length: sec.count }).map((_, i) => (
                        <rect
                            x="5"
                            y={sec.yStart + i * 3.4}
                            width="14"
                            height="2.6"
                            rx="0.5"
                            fill={slotColor}
                        />
                    ))}
                </>
            ))}

            {/* Right column - Team 2 */}
            {sections.map((sec) => (
                <>
                    {Array.from({ length: sec.count }).map((_, i) => (
                        <rect
                            x="21"
                            y={sec.yStart + i * 3.4}
                            width="14"
                            height="2.6"
                            rx="0.5"
                            fill={slotColor}
                        />
                    ))}
                    <rect
                        x="36.5"
                        y={sec.yStart}
                        width="1.5"
                        height={sec.count * 3.4 - 0.8}
                        rx="0.75"
                        fill={sec.color}
                    />
                </>
            ))}
        </svg>
    );
}

const layoutIconMap: Record<CardLayout, (props: LayoutIconProps) => ReturnType<typeof VerticalIcon>> = {
    vertical: VerticalIcon,
    horizontal: HorizontalIcon,
    compact: CompactIcon,
    wide: WideIcon,
    "draft-order": DraftOrderIcon,
    "wide-draft-order": WideDraftOrderIcon
};

export { layoutIconMap, VerticalIcon, HorizontalIcon, CompactIcon, WideIcon, DraftOrderIcon, WideDraftOrderIcon };
export type { LayoutIconProps };
