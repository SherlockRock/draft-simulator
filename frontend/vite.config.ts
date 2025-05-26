import { defineConfig } from "vite";
import fs from "fs";
import solidPlugin from "vite-plugin-solid";
// import devtools from 'solid-devtools/vite';

export default defineConfig({
    plugins: [solidPlugin()],
    server: {
        https: {
            key: fs.readFileSync("./localhost+2-key.pem"),
            cert: fs.readFileSync("./localhost+2.pem")
        },
        proxy: {
            "/api": "https://localhost:3000"
        },
        watch: {
            usePolling: true
        }
    }
});
