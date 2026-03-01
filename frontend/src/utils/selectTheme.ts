export type SelectTheme = "teal" | "orange" | "purple";

export const themeColors = {
    teal: {
        border: "border-teal-700",
        focusBorder: "focus:border-teal-400",
        ring: "focus:ring-teal-400",
        text: "text-teal-400",
        hoverText: "hover:text-teal-400",
        hoverBorder: "hover:border-teal-400",
        dropdownBorder: "border-teal-400",
        groupHoverText: "group-hover:text-teal-400",
        groupHoverBorder: "group-hover:border-teal-500",
        activeBorder: "border-teal-500",
        ringColor: "ring-teal-400",
        hoverBorderLight: "hover:border-teal-500"
    },
    orange: {
        border: "border-orange-500/60",
        focusBorder: "focus:border-orange-400",
        ring: "focus:ring-orange-400",
        text: "text-orange-400",
        hoverText: "hover:text-orange-400",
        hoverBorder: "hover:border-orange-400",
        dropdownBorder: "border-orange-400",
        groupHoverText: "group-hover:text-orange-400",
        groupHoverBorder: "group-hover:border-orange-500",
        activeBorder: "border-orange-500",
        ringColor: "ring-orange-400",
        hoverBorderLight: "hover:border-orange-500"
    },
    purple: {
        border: "border-purple-700",
        focusBorder: "focus:border-purple-400",
        ring: "focus:ring-purple-400",
        text: "text-purple-400",
        hoverText: "hover:text-purple-400",
        hoverBorder: "hover:border-purple-400",
        dropdownBorder: "border-purple-400",
        groupHoverText: "group-hover:text-purple-400",
        groupHoverBorder: "group-hover:border-purple-500",
        activeBorder: "border-purple-500",
        ringColor: "ring-purple-400",
        hoverBorderLight: "hover:border-purple-500"
    }
} as const;

export const getThemeColors = (theme: SelectTheme) => themeColors[theme];
