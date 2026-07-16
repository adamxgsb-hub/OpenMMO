---
name: open-localhost-game
description: Open the local OpenMMO development game in the Codex in-app browser, sign in with Google, select the default character, and press Start to enter the game. Use when the user asks Codex to connect to localhost:10004, log into OpenMMO, choose the default character, start the game, or restore the browser to the in-game state.
---

# Open Localhost Game

## Overview

Drive the Codex in-app browser through the local OpenMMO entry flow. Login is
Google OAuth only (password login was removed). The expected path is: open
`http://localhost:10004/`, click **Sign in with Google**, complete Google's
account chooser, keep the default selected character, and press `Start`.

## Workflow

1. Use the `browser-use:browser` skill and the in-app browser runtime.
2. Navigate to `http://localhost:10004/` unless the current tab is already there
   and the user has in-progress state worth preserving.
3. If the login screen shows an error instead of the button (e.g.
   `VITE_GOOGLE_CLIENT_ID is not configured`, `Google sign-in is not configured
   on this server`), report it and stop — it is a config/deploy problem.
4. Click the **Sign in with Google** button.
5. In Google's popup/account chooser: if an account is already signed in, select
   it. If Google asks for an email, password, or 2FA, hand off to the user and
   wait — never enter Google credentials yourself, even if provided in chat.
6. Confirm the character-select screen appears (`Character Select` + the account
   label). First login with a fresh Google account auto-creates an empty
   account (random `player_...` name) — if the character list is empty, tell the
   user rather than creating characters.
7. Keep the default selected character unless the user requests another.
8. Click `Start`.
9. Confirm the game UI appears. Expected signals include `Chat`, `Inventory (I)`,
   `World Map (M)`, and sometimes a `Preparing world...` dialog.

## Browser Notes

Prefer stable Playwright locators based on the visible screen:

```js
await tab.goto("http://localhost:10004/");
// The GIS button renders inside an iframe; match by its accessible name.
await tab.playwright.getByRole("button", { name: /sign in with google/i }).click({ timeoutMs: 8000 });
// ...user completes Google auth; wait for character select...
await tab.playwright.getByRole("button", { name: "Start", exact: true }).click({ timeoutMs: 8000 });
```

If the login button is not visible, inspect the current screen first: the
browser may already be signed in, on character select, or inside the game.

## Reporting

Keep the response concise. Report the final screen and any visible confirmation
such as `Character Select`, the account label, or the in-game controls. Never
echo Google credentials.
