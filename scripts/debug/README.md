# Draft pick delivery regressions

Run from the repository root after installing dependencies and running
`pnpm build:types`.

```sh
node scripts/debug/canvas-reconnect-repro.cjs
node scripts/debug/draft-pick-persistence.cjs
```

The socket harness starts a temporary loopback server. It exercises the actual
Canvas pick handler and projection, the shared delivery queue, the backend socket
adapter, and the reconnect callbacks with real Socket.IO connections. Persistence
uses an in-memory fixture. Checks cover a healthy save, three dropped-message
reconnects, a dropped acknowledgement, a stale copy snapshot, and exactly one
refetch per automatic reconnect. Source boundary assertions fail if the extracted
handlers move or change shape.

The persistence harness requires PostgreSQL 16 or 17 binaries under
`/usr/lib/postgresql/`. It starts a temporary cluster with a Unix socket, injects
that connection before loading application models, and never reads application
database configuration. It checks migration up/down, duplicate and competing
mutations, receipts surviving a fresh service instance, stale retries, and legacy
write revision advancement. The temporary cluster is removed on completion.

Both scripts need local socket permissions. Neither contacts production.

## Deployment order

Apply `20260911120000-add-draft-pick-revision.js` and deploy the backend before
publishing the updated frontend. The backend start command runs pending migrations.
Old clients can still send `newDraft`; those writes and canvas import overwrites
advance the revision and invalidate earlier mutation receipts. A new frontend
requires the backend's acknowledged `updateDraftPicks` protocol.

Pending edits are retained in memory across socket reconnects and navigation
between canvas and draft views. They are cleared on logout/provider disposal;
this does not provide persistence across a full browser reload. Manual versus
series retain their existing editing protocol. The server heartbeat timeout is
unchanged; these checks prove delivery recovery, not the cause of an interruption.
