# AGENTS.md

prwatch watches the user's open pull requests and types each new change into the coding agent working on that branch.

## Commands

`just` lists the recipes; each one calls a package script. `pnpm run check` is format check, lint, typecheck and tests. TypeScript runs directly on Node 24 (`node bin/prwatch.ts`), with no build step in development.

## Shipping

`./build.sh <version>` compiles the CLI into one binary with `bun build --compile`, builds the Swift menu bar app in `app/`, and assembles `build/prwatch.app` with the CLI at `Contents/Helpers/prwatch`, plus a zip for the GitHub release. The app runs `Helpers/prwatch run` through the user's login shell and restarts it if it exits, links the CLI into `~/.local/bin` on request, and reads `status.json`. Releases are the zip on GitHub, which the `seethruhead/tap` Homebrew formula installs. There is no npm package.

## Updates

The app checks GitHub's latest release at launch and every 6 hours (`app/Sources/PrwatchBar/Update.swift`). When it's newer than the app's own version, an **Update x.y.z** button appears next to Quit. Clicking it hands off to a small script and quits; the script waits for the app to exit, installs the new version and reopens it. An app running from a Homebrew Cellar is upgraded with `brew upgrade seethruhead/tap/prwatch` and reopened from its `opt` path. Any other copy is replaced in place from the release zip, and a failed download or copy keeps the old app. The version shows next to the title.

## How it starts

`bin/prwatch.ts` is the only entry point and the only place `Effect.run*` happens (through `Command.run` and `NodeRuntime.runMain`). Each command provides the layers it needs.

## Modules

- `Brands`: the branded strings and numbers (ids, SHAs, logins, URLs, times, text) and GitHub's enums as literal unions. Values are decoded into brands at the edge (GitHub, the multiplexers, the CLI, the state files).
- `Shell`: the only module that starts processes. Every command has a 30 second timeout and fails with `CommandFailed`.
- `GitHub`: GraphQL through `gh`, decoded with Schema into `PullRequest`. `pullRequests` fetches every open pull request in full; `stamps` is a cheap probe of what each one looks like now (updated time, head, CI, review decision, mergeable); `pullsById` fetches only the ones whose stamp moved.
- `Changes`: pure. Diffs a pull request against what was seen last time. The first sight of a pull request is a baseline and produces nothing.
- `Message`: pure. The text an agent receives and the notification text.
- `Host`: the service a multiplexer provides. `hosts/Herdr.ts`, `hosts/Cmux.ts`, `hosts/Orca.ts` and `hosts/Tmux.ts` are its layers. `hosts/Claude.ts` wraps whichever one runs: it lists Claude Code sessions with `claude agents --json`, delivers to a session through its inbox socket (the path comes from `~/.claude/sessions/*.json`), and hands every other agent to the wrapped host. A Claude pane in the same directory as a session is left out so the session is not messaged twice.
- `Workspace`: the repository and branch of a working directory, read with git.
- `Store`: `seen.json` and `status.json` under `PRWATCH_HOME`.
- `Watcher`: one cycle (fetch, diff, route, deliver, notify, save) and the repeating watch, which probes stamps every `--probe` seconds, refetches only what moved, and fetches everything every `--interval` seconds.

## What the linter enforces

- Only `src/Shell.ts` may import `effect/process`.
- No nested ternaries, `const` only, `type` instead of `interface`.
- No bare `string` or `number` in `src/` or `bin/` (`prwatch/branded`, in `tools/oxlint-plugin.ts`): use a brand from `src/Brands.ts` or a literal union, and a `Schema.String`/`Schema.Number` only when it is piped into `Schema.brand`. `src/Shell.ts` is exempt, because it is where raw process text comes in; it hands back `Stdout`.

## What reviewers check instead

- Pure modules stay pure: `Changes` and `Message` take values and return values.
- A new host is one layer of `Host`; nothing outside `src/hosts/` knows which host is running.
- `status.json` is read by other programs. Fields are only added, never renamed or removed, and new fields are optional.
- No employer names, internal hostnames or private details in code, tests or docs.
