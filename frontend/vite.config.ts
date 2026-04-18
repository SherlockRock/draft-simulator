import { defineConfig, loadEnv } from "vite";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import solidPlugin from "vite-plugin-solid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findCertPath(): string | null {
    const localPath = ".";
    const sharedPath = path.join(os.homedir(), ".config/local-certs");

    if (fs.existsSync(path.join(localPath, "localhost+2.pem"))) {
        return localPath;
    }
    if (fs.existsSync(path.join(sharedPath, "localhost+2.pem"))) {
        return sharedPath;
    }
    return null;
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const certPath = env.VITE_ENVIRONMENT === "development" ? findCertPath() : null;

    return {
        plugins: [solidPlugin()],
        resolve: {
            dedupe: ["solid-js", "solid-js/web", "solid-js/store"]
        },
        build: {
            rollupOptions: {
                input: {
                    main: path.resolve(__dirname, "index.html"),
                    "test-trees": path.resolve(__dirname, "test-trees.html")
                }
            }
        },
        server: {
            https: certPath
                ? {
                      key: fs.readFileSync(path.join(certPath, "localhost+2-key.pem")),
                      cert: fs.readFileSync(path.join(certPath, "localhost+2.pem"))
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
