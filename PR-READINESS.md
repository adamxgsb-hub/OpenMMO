# Shipping this upstream — what actually matters

Findings from reading the upstream repo's conventions and its five most
recently merged outside PRs, plus what's already been done about each.

## The one real risk: fishing isn't on his roadmap

`doc/TODO.md` has no entry for fishing, gathering professions, or a skill
system. Everything on that list is his own plan. **This contribution is
unsolicited**, which makes PR0 not a courtesy but the thing that decides
whether nine PRs are welcome or an imposition.

Send `PR0-fishing-proposal.md` as an issue and wait for a reply before opening
code PRs. A "yes, but make the skill system look like X" saves everyone a
review cycle; a "no thanks" saves you weeks.

## His quality gate is written down

`.claude/agents/commit-agent.md` is effectively his pre-commit checklist:

1. `npm run format` — Prettier, **no semicolons, single quotes**
2. `npm run lint` — ESLint, must be clean
3. `npm run check` — svelte-check + tsc
4. Commit message: **English, present-tense verb** (Add/Fix/Update/Refactor/
   Remove/Improve), **first line under 72 characters**, describing *what*
   changed

Status: all four now hold across the stack. Seven client files were not
Prettier-formatted (they are now, folded into their own commits so each PR is
individually clean), one commit subject was 77 characters (reworded), ESLint
was already clean, and Prettier + ESLint are now enforced in
`ci/fishing-tests` so it can't regress.

## What a merged feature PR looks like there

PR #17 ("Add /w whispers delivered to one player at any distance") is the
closest analogue — a feature crossing every plane of the codebase:

```
agent-client/data/system_prompt.txt   +4      client/src/lib/...            
agent-client/src/driver/prompt.rs     +8      doc/TODO.md                   -1/+1
agent-client/src/state.rs            +12      server/src/game_state/chat.rs  +91
shared/src/messages.rs                +9      server/src/game_state/tests.rs +172
shared/src/lib.rs                     +2  (protocol bump)
```

Read that shape: **server + client + agent-client + shared + tests, in one
coherent PR, with a protocol bump and a TODO update.** Our stack matches it,
including the agent-client work and the `system_prompt.txt` entry that tells
agents fishing exists — without which no agent would ever fish.

## Process facts

- **No CONTRIBUTING.md, no PR template.** The bar is set by what he merges.
- **CLA required.** A bot comments on your first PR; sign by commenting
  exactly: `I have read the CLA Document and I hereby sign the CLA`
- **AI-assisted work is explicitly fine.** He commits with
  `Co-Authored-By: Claude` himself and allowlisted `Claude*` in the CLA bot.
- **He merges with "Merge PR #N: <subject>"** — no squash, so your commit
  history is what lands. Keep it clean.

## Recommendations

**Open one PR at a time.** Nine at once is a wall of review for a solo
maintainer. Open PR1 (skills), let it merge, then PR2. Each is written to
stand alone.

**Put a GIF in the PR body.** His README is heavily illustrated — cast → bite →
struggle → catch in ten seconds communicates more than the description will.
Screenshots of the inventory icons and the character holding the rod too.

**Lead with agent parity.** It's the project's stated core principle, and the
struggle broadcast was designed around it — same information to the human UI
and the agent, windows sized for a network round trip. Say that early.

**Offer to drop things.** The Waterlogged Cache, the flotsam, even the trained
skill cap — naming what you'd happily cut makes a "yes, but" easy to give.

**Don't include `ci/fishing-tests`.** Upstream runs no test CI; that branch is
for your fork only.

## Pre-flight checklist

- [ ] PR0 posted and answered
- [ ] Real GitHub fork of `Julian-adv/OpenMMO` created (forks share LFS storage)
- [ ] Rebased on current upstream master
- [ ] `cargo fmt --all --check` clean, `cargo test --workspace` green
- [ ] `npm run format:check`, `npm run lint`, `npm run check`, `npm test` green
- [ ] Played it yourself: cast, bite, struggle, catch, eat, sell, and the
      abort paths (walk away, get attacked, unequip the rod)
- [ ] GIF + screenshots captured
- [ ] CLA signed on the PR
- [ ] `ci/fishing-tests` excluded
