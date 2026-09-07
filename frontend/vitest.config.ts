import { defineConfig } from "vitest/config";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
    // The solid plugin compiles JSX in .test.tsx files. Component tests opt
    // into jsdom per file with `// @vitest-environment jsdom`; utils tests stay
    // in node (memory solidjs_server_build_reconcile — browser conditions keep
    // solid-js/store on the browser build in BOTH environments). The same opt-in
    // is required for any .test.ts whose import graph merely reaches a .tsx file:
    // the plugin compiles every component to DOM output (generate: 'dom') regardless
    // of the importing test's environment, so module-scope delegateEvents() needs
    // `window` even when nothing is rendered.
    plugins: [solidPlugin()],
    resolve: {
        conditions: ["browser", "development"]
    },
    ssr: {
        resolve: {
            conditions: ["browser", "development"]
        }
    },
    test: {
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        environment: "node"
    }
});
