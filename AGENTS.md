# AGENTS.md: using the vend16 CLI

You are a coding agent asked to add in-app purchases to an app with Vend16. The CLI does the account, key and package work; you then wire purchases into the code.

## 1. Run init

In the app's root folder:

```bash
npx github:spruikco/vend16-cli init --yes --json
```

- The first time, it prints a sign-in code to stderr and opens https://vend16.com/activate. **Show the person that code and ask them to approve it.** The command waits (up to 15 minutes) and carries on by itself.
- If the app has its own backend, add `--server-env path/to/server/.env` so the secret key goes there. Never pass a file git tracks. Never read the key back out, print it or commit it.
- Exit 4 with `candidates` means several Vend16 apps match: ask the person which one and rerun with `--app app_...`.
- Exit 5 with "not switched on yet": the server's CLI sign-in is not live. Fall back to asking the person for their public key from https://vend16.com/app (Setup page).

## 2. Read the result

From the JSON on stdout:

- `public_key.read_with`: how the app code reads the key. Use exactly that.
- `next[0]`: the wiring guide for this stack. Read it and follow it.
- `manual`: things a person must do. Tell them.
- `setup`: the store checklist. Repeat the items that are not `done` to the person at the end.

## 3. Wire purchases into the code

Follow the stack's guide from `next[0]`. Whatever the stack, these rules are not optional:

1. Send every completed store purchase to Vend16 (`POST /v1/receipts`, or the plugin helper) with the app's stable user ID.
2. Call the store's finish, consume or acknowledge only after Vend16 replies `recorded` or `duplicate`.
3. On a network error or `502 store_unavailable`, do not finish: the store redelivers it.
4. On `422 invalid_receipt`, finish it and unlock nothing.
5. Unlock features from `GET /v1/subscribers/:appUserId` (`active_product_ids`), never from the device.

## 4. Check

```bash
npx github:spruikco/vend16-cli doctor --json
```

Fix every check with `level: "error"`. Report the `warn` ones (mostly store setup) to the person.
