## Usage

frontend:

```bash
$ cd frontend
$ npm install # or pnpm install or yarn install
$ npm run dev
```

backend:
setup postgres db based on .env.sample then do the following

```bash
$ cd backend
$ npm install # or pnpm install or yarn install
$ node index.js
```

## Rust toolchain (for engine-core / engine-node)

This repo includes a Rust workspace at `/Cargo.toml` containing `engine-core`
(pure compute crate) and `engine-node` (napi-rs cdylib consumed by the
backend).

- One-time setup: `rustup default stable`
- Build the napi binding: `pnpm --filter @draft-sim/engine-node build`
- Engine dev with auto-rebuild: `pnpm --filter @draft-sim/engine-node dev`
- Engine tests: `cd packages/engine-core && cargo test`
- Engine benchmarks: `cd packages/engine-core && cargo bench`

The compiled `.node` binary is gitignored — produced fresh on every build.
Backend depends on `@draft-sim/engine-node` via the pnpm workspace; run
`pnpm install` once after a fresh clone, then build the napi binding before
starting the backend.

## Available Scripts

In the project directory, you can run:

### `npm run dev` or `npm start`

Runs the app in the development mode.<br>

The page will reload if you make edits.<br>

### `npm run build`

Builds the app for production to the `dist` folder.<br>
It correctly bundles Solid in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.<br>
Your app is ready to be deployed!

## Deployment

You can deploy the `dist` folder to any static host provider (netlify, surge, now, etc.)
