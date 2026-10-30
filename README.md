# prwatch

Your coding agents babysit pull requests by polling GitHub. prwatch does the polling once, for all of them, and hands each change to the agent already working on that branch.

When a review, a comment, a review-thread reply, a CI result or an approval lands on one of your open pull requests, prwatch finds the terminal pane whose working directory is that repository on that branch and types a message into the agent running there. The agent reacts instead of polling. If something needs you (a person commented, the PR was approved, it is ready to merge) or no agent is on that branch, you get a notification.

```
[prwatch] acme/app#42 "Add the thing" (https://github.com/acme/app/pull/42) has updates:
- review comment from jo on src/api.ts:18: "Could this reuse the existing retry?" https://github.com/acme/app/pull/42#discussion_r1
- CI failed on 3fb8d36
Read each thread in full with gh before acting. Fix what bots raise yourself. For comments from people, draft your reply and any change, and show them to the user before posting anything.
```

## Install (macOS)

Download `prwatch-<version>-macos-arm64.zip` from the latest release, unzip it and move `prwatch.app` to Applications. The app is not notarized, so the first time, right-click it and choose Open (or run `xattr -dr com.apple.quarantine /Applications/prwatch.app`).

The app is the whole thing. It runs the watcher in the background, shows a bell with the number of pull requests that need you, and lists each one with its latest update, the agent it went to, and buttons to open it, focus that agent's pane or mark it seen. From its menu:

- **Open at login** starts it with your Mac.
- **Install command line tool** links `prwatch` into `~/.local/bin`, so agents and you can run `prwatch claim`, `prwatch status` and the rest.

It needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth status`) and your agents running in a supported multiplexer. The watcher runs through your login shell, so it sees the same `PATH` you do.

## Run from source (macOS or Linux)

Node 24 or later runs the TypeScript directly:

```sh
pnpm install
node bin/prwatch.ts run
```

## Multiplexers

| Host  | Finds agents by                                                                                                                                             | Delivers with               | Notifies with             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------- |
| herdr | `herdr agent list` (agent, status, working directory)                                                                                                       | `herdr agent prompt`        | `herdr notification show` |
| tmux  | panes whose current command is a known agent (`claude`, `codex`, `opencode`, `gemini`, `pi`, `amp`, `aider`, `cursor-agent`, plus `PRWATCH_AGENT_COMMANDS`) | a bracketed paste and Enter | `tmux display-message`    |

cmux only lets processes started inside cmux use its socket by default. prwatch runs outside it, so set cmux's socket access to password in its settings (the `cmux` CLI reads the password from the keychain), or launch cmux with `CMUX_SOCKET_MODE=allowAll`.

`--host auto` (the default) uses the first that answers: herdr, cmux, then tmux. Agents that herdr reports as blocked on a question are skipped, so a message never answers an approval prompt for you. Agents that are busy still get the message; Claude Code, Codex and the rest queue typed input until they finish.

Adding a host is one file in `src/hosts/` that provides the `Host` service: list agents with their working directory, deliver text to one, and show a notification.

## Use

```sh
prwatch once              # first run records what exists; later runs deliver what changed
prwatch once --dry-run    # print what would be sent
prwatch run               # see which pull requests changed every 10 seconds (--probe), fetch everything every 2 minutes (--interval)
prwatch status            # the pull requests being watched; ● marks the ones that need you
prwatch ack acme/app#42   # clear the ● once you have looked
```

### Pull requests you are reviewing

prwatch also watches open pull requests you have commented on or reviewed but did not open. For those it delivers replies in review threads you are part of, comments that mention you, and new commits pushed after you looked.

An agent gets a pull request's updates when its working directory is that repository on the pull request's branch, on a `pr-<number>` branch, or detached at one of its commits. An agent that reviews many pull requests from one directory claims them instead:

```sh
prwatch claim acme/app#42      # from inside the agent's pane; uses $HERDR_PANE_ID or $TMUX_PANE
prwatch claim https://github.com/acme/app/pull/42 --agent w1:p3
prwatch release acme/app#42
prwatch claims
```

A claim ends by itself when the pane goes away or the pull request closes.

`--instructions "..."` and `--review-instructions "..."` replace the line appended to messages about your own pull requests and about ones you are reviewing.

Notifications on herdr are silent. Set `PRWATCH_NOTIFY_SOUND` to `done` or `request` in your shell profile to hear one; the menu bar app starts the watcher through your login shell, so it picks the setting up on its next restart.

State lives in `~/.prwatch` (`PRWATCH_HOME` to change it): `seen.json` for what has already been delivered and `status.json` for tools such as a menu bar app.

## Development

```sh
pnpm install
just check          # format, lint, typecheck, tests
./build.sh          # build/prwatch.app and a release zip (needs Bun and the Xcode command line tools)
```
