import { defineConfig, loadEnv } from "vite";
import fs from "fs";
import solidPlugin from "vite-plugin-solid";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");

    return {
        plugins: [solidPlugin()],
        server: {
            https:
                env.NODE_ENV === "development"
                    ? {
                          key: fs.readFileSync("./localhost+2-key.pem"),
                          cert: fs.readFileSync("./localhost+2.pem")
                      }
                    : undefined,
            proxy: {
                "/api": {
                    target: env.VITE_API_URL,
                    changeOrigin: true,
                    secure: false
                }
            },
            watch: {
                usePolling: true
            }
        }
    };
});
