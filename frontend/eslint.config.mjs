import typescriptEslint from "@typescript-eslint/eslint-plugin";
import prettier from "eslint-plugin-prettier";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [
    {
        ignores: ["**/node_modules", "**/dist"]
    },
    ...compat.extends(
        "eslint:recommended",
        "plugin:solid/recommended",
        "plugin:@typescript-eslint/recommended",
        "plugin:prettier/recommended"
    ),
    {
        plugins: {
            "@typescript-eslint": typescriptEslint,
            prettier
        },

        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node
            },

            parser: tsParser,
            ecmaVersion: 2021,
            sourceType: "module",

            parserOptions: {
                ecmaFeatures: {
                    jsx: true
                },

                project: "./tsconfig.json"
            }
        },

        rules: {
            "prettier/prettier": "error",

            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_"
                }
            ],

            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "no-console": "warn"
        }
    }
];
