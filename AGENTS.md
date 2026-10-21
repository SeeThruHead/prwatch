# AGENTS.md

prwatch watches the user's open pull requests and types each new change into the coding agent working on that branch.

## Commands

`just` lists the recipes; each one calls a package script. `pnpm run check` is format check, lint, typecheck and tests. TypeScript runs directly on Node 24 (`node bin/prwatch.ts`), with no build step in development.

## Shipping

`./build.sh <version>` compiles the CLI into one binary with `bun build --compile`, builds the Swift menu bar app in `app/`, and assembles `build/prwatch.app` with the CLI at `Contents/Helpers/prwatch`, plus a zip for the GitHub release. The app runs `Helpers/prwatch run` through the user's login shell and restarts it if it exits, links the CLI into `~/.local/bin` on request, and reads `status.json`. There is no npm or Homebrew package.

## How it starts

`bin/prwatch.ts` is the only entry point and the only place `Effect.run*` happens (through `Command.run` and `NodeRuntime.runMain`). Each command provides the layers it needs.

## Modules

- `Shell`: the only module that starts processes. Every command has a 30 second timeout and fails with `CommandFailed`.
- `GitHub`: one GraphQL query through `gh` for the viewer's open pull requests, decoded with Schema into `PullRequest`.
- `Changes`: pure. Diffs a pull request against what was seen last time. The first sight of a pull request is a baseline and produces nothing.
- `Message`: pure. The text an agent receives and the notification text.
- `Host`: the service a multiplexer provides. `hosts/Herdr.ts` and `hosts/Tmux.ts` are its layers.
- `Workspace`: the repository and branch of a working directory, read with git.
- `Store`: `seen.json` and `status.json` under `PRWATCH_HOME`.
- `Watcher`: one cycle (fetch, diff, route, deliver, notify, save) and the repeating watch.

## What the linter enforces

- Only `src/Shell.ts` may import `effect/process`.
- No nested ternaries, `const` only, `type` instead of `interface`.

## What reviewers check instead

- Pure modules stay pure: `Changes` and `Message` take values and return values.
- A new host is one layer of `Host`; nothing outside `src/hosts/` knows which host is running.
- `status.json` is read by other programs. Fields are only added, never renamed or removed, and new fields are optional.
- No employer names, internal hostnames or private details in code, tests or docs.
