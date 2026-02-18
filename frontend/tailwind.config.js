/** @type {import('tailwindcss').Config} */
export default {
    content: ["./src/**/*.{js,jsx,ts,tsx}"],
    theme: {
        extend: {
            dropShadow: {
                glow: [
                    "0 0px 20px rgba(255,255, 255, 0.35)",
                    "0 0px 65px rgba(255, 255,255, 0.2)"
                ]
            },
            animation: {
                pop: "pop 0.3s ease-out"
            },
            keyframes: {
                pop: {
                    "0%": { transform: "scale(1)", filter: "brightness(1)" },
                    "50%": { transform: "scale(1.15)", filter: "brightness(1.3)" },
                    "100%": { transform: "scale(1)", filter: "brightness(1)" }
                }
            }
        }
    },
    plugins: []
};
