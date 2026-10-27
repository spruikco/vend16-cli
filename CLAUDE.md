# CLAUDE.md

Using this CLI to add purchases to an app? Follow [AGENTS.md](AGENTS.md).

Working on the CLI: zero runtime dependencies, Node 20+, ESM. Every server route lives in `ENDPOINTS` in src/api.js. `npm test` runs node:test against a fake server (test/helpers.js). Never print a secret key (sk_). No em dashes in docs.
