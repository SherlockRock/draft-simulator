import { defineConfig } from "vite";
import fs from "fs";
import solidPlugin from "vite-plugin-solid";
// import devtools from 'solid-devtools/vite';

export default defineConfig({
    plugins: [solidPlugin()],
    server: {
        https:
            process.env.NODE_ENV === "development"
                ? {
                      key: fs.readFileSync("./localhost+2-key.pem"),
                      cert: fs.readFileSync("./localhost+2.pem")
                  }
                : undefined,
        proxy: {
            "/api": { target: process.env.VITE_API_URL }
        },
        watch: {
            usePolling: true
        }
    }
});
