export type SelectTheme = "neutral" | "orange" | "crimson" | "purple";

export const themeColors = {
    neutral: {
        border: "border-darius-border/50",
        focusBorder: "focus:border-darius-border",
        ring: "focus:ring-darius-border",
        text: "text-darius-text-primary",
        hoverText: "hover:text-darius-text-primary",
        hoverBorder: "hover:border-darius-border",
        dropdownBorder: "border-darius-border/50",
        groupHoverText: "group-hover:text-darius-text-primary",
        groupHoverBorder: "group-hover:border-darius-border",
        activeBorder: "border-darius-border",
        ringColor: "ring-darius-border",
        hoverBorderLight: "hover:border-darius-border"
    },
    orange: {
        border: "border-darius-ember",
        focusBorder: "focus:border-darius-ember",
        ring: "focus:ring-darius-ember",
        text: "text-darius-ember",
        hoverText: "hover:text-darius-ember",
        hoverBorder: "hover:border-darius-ember",
        dropdownBorder: "border-darius-ember",
        groupHoverText: "group-hover:text-darius-ember",
        groupHoverBorder: "group-hover:border-darius-ember",
        activeBorder: "border-darius-ember",
        ringColor: "ring-darius-ember",
        hoverBorderLight: "hover:border-darius-ember"
    },
    crimson: {
        border: "border-darius-crimson",
        focusBorder: "focus:border-darius-crimson",
        ring: "focus:ring-darius-crimson",
        text: "text-darius-crimson",
        hoverText: "hover:text-darius-crimson",
        hoverBorder: "hover:border-darius-crimson",
        dropdownBorder: "border-darius-crimson",
        groupHoverText: "group-hover:text-darius-crimson",
        groupHoverBorder: "group-hover:border-darius-crimson",
        activeBorder: "border-darius-crimson",
        ringColor: "ring-darius-crimson",
        hoverBorderLight: "hover:border-darius-crimson"
    },
    purple: {
        border: "border-darius-purple",
        focusBorder: "focus:border-darius-purple-bright",
        ring: "focus:ring-darius-purple-bright",
        text: "text-darius-purple-bright",
        hoverText: "hover:text-darius-purple-bright",
        hoverBorder: "hover:border-darius-purple-bright",
        dropdownBorder: "border-darius-purple-bright",
        groupHoverText: "group-hover:text-darius-purple-bright",
        groupHoverBorder: "group-hover:border-darius-purple",
        activeBorder: "border-darius-purple",
        ringColor: "ring-darius-purple-bright",
        hoverBorderLight: "hover:border-darius-purple"
    }
} as const;

export const getThemeColors = (theme: SelectTheme) => themeColors[theme];
