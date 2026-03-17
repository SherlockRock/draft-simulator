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
                pop: "pop 0.3s ease-out",
                "cat-breathe": "cat-breathe 3s ease-in-out infinite",
                "cat-blink": "cat-blink 4s ease-in-out infinite"
            },
            keyframes: {
                pop: {
                    "0%": { transform: "scale(1)", filter: "brightness(1)" },
                    "50%": { transform: "scale(1.08)", filter: "brightness(1.3)" },
                    "100%": { transform: "scale(1)", filter: "brightness(1)" }
                },
                "cat-breathe": {
                    "0%, 100%": { transform: "translateY(0)" },
                    "50%": { transform: "translateY(-2px)" }
                },
                "cat-blink": {
                    "0%, 90%, 100%": { opacity: "1" },
                    "95%": { opacity: "0" }
                }
            }
        }
    },
    plugins: []
};
