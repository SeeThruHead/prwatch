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
- **Update x.y.z** appears next to Quit when a newer release is out. Click it and prwatch quits, installs the new version (through Homebrew if that's how you installed it), and reopens.

It needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth status`) and your agents running in a supported multiplexer. The watcher runs through your login shell, so it sees the same `PATH` you do.

## Run from source (macOS or Linux)

Node 24 or later runs the TypeScript directly:

```sh
pnpm install
node bin/prwatch.ts run
```

## Claude Code sessions

When a Claude Code session is working on a pull request's branch, prwatch messages that session directly instead of typing into its terminal. It finds sessions with `claude agents --json` and posts to each session's inbox socket, the one Claude Code uses for [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging). The message arrives in the session like one from another session, between tool calls or as a new turn when it is idle. Nothing is typed into a terminal, so it can't land in the wrong window, and it works wherever the session runs: herdr, cmux, Orca, tmux, a plain terminal or a background session. Agents that aren't Claude Code sessions still go through the multiplexer below.

A session that bypasses permission prompts holds a message from outside Claude Code for your approval. To let prwatch's messages through without a prompt each time, set `"crossSessionInbound": "accept"` in `~/.claude/settings.json`. That accepts messages from your other local sessions too.

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
prwatch claim acme/app#42      # from inside the agent; a Claude Code session claims itself, otherwise $HERDR_PANE_ID or $TMUX_PANE
prwatch claim https://github.com/acme/app/pull/42 --agent w1:p3
prwatch release acme/app#42
prwatch claims
```

A claim ends by itself when the session or pane goes away, or three days after the pull request closes, so the deploy of what you merged still reaches the pane that worked on it.

`--instructions "..."` and `--review-instructions "..."` replace the line appended to messages about your own pull requests and about ones you are reviewing.

Notifications on herdr are silent. Set `PRWATCH_NOTIFY_SOUND` to `done` or `request` in your shell profile to hear one; the menu bar app starts the watcher through your login shell, so it picks the setting up on its next restart.

### Runs, deployments and releases

Pull requests are not the only thing worth hearing about. A deploy you started finishes long after the pull request closed, and a preview dispatched from a portal belongs to a pull request without being a check on it. Watch rules tell prwatch which of these to follow and whose they are. With no rules, nothing changes.

Rules live in `config.json` and `config.local.json` in `~/.config/prwatch` (`PRWATCH_CONFIG_DIR` to change it). Keep `config.json` where your dotfiles are tracked and `config.local.json` for one machine; a rule in the local file replaces the shared rule with the same name. A rule applies only on machines whose name matches `machines` (`PRWATCH_MACHINE`, default the hostname).

```json
{
  "rules": [
    {
      "name": "main deploys",
      "repos": ["acme/*"],
      "events": ["push"],
      "branches": ["main"],
      "link": "merge-commit",
      "notify": { "on": ["failed", "succeeded"], "to": ["pane", "menubar"] }
    },
    {
      "name": "previews",
      "repos": ["acme/shop"],
      "workflows": ["*Preview*"],
      "link": "pr-head-sha"
    },
    {
      "name": "tagged releases",
      "source": "release",
      "repos": ["acme/*"],
      "where": [{ "field": "tag_name", "regex": "^v\\d+\\.\\d+\\.\\d+$" }],
      "link": "actor"
    }
  ]
}
```

- **`source`** is what to watch: `workflow_run` (the default), `check_run`, `commit_status`, `deployment` or `release`. Check runs and statuses are read for your open pull requests and the latest commits on each repository.
- **`repos`** are `owner/name` globs. The owner must be literal, so `acme/*` works and `*/shop` does not.
- **`events`, `workflows`, `branches`, `environments`** are shortcuts for the common fields of each source. `where` matches any field of the GitHub payload: `{ "field": "app.slug", "in": ["ci"] }`, `{ "field": "head_branch", "glob": "release/*" }`, `{ "field": "display_title", "regex": "#(\\d+)" }` or `{ "field": "pull_requests.number", "exists": true }`. A field inside an array matches if any element does. Globs ignore case.
- **`link`** decides whose it is. `actor`: you started it. `merge-commit`: it built the merge commit of a pull request you opened. `pr-head-sha`: it ran on the head commit of one of your open pull requests. `claim`: any pull request that matches the commit, delivered only to panes that claimed it. `any`: everything that matches. Or `{ "extract": { "from": "head_branch", "regex": "^pr-(\\d+)$", "as": "pr-number" } }` to read a pull request number, a `branch` or a `sha` out of a field.
- **`notify`** says which `on` outcomes (`started`, `succeeded`, `failed`, `cancelled`, `completed` for any finished outcome) go `to` the agent's `pane`, the `menubar` and a desktop notification, or both. The default is failed and succeeded to the pane. A pane is chosen the way it is for pull requests: the ones that claimed the pull request or the run, and the worktree on the run's branch.
- **`command`** is a shell command that gets the run as JSON on stdin and answers `{ "linked": true, "pr": "acme/shop#7", "message": "rolled back" }` or `{ "linked": false }`, so a repository with its own conventions never needs a change to prwatch.

The first time rules exist, prwatch records the time and reports only runs that change after that. A run that is still going is followed until it finishes. Runs are checked every `--runs-interval` seconds (default 30) and nothing older than a day is read. When every rule for a repository links by `actor`, prwatch asks GitHub only for your runs.

```sh
prwatch config path       # where rules are read from, and this machine's name
prwatch config show       # every rule and the file it came from (--json for tools)
prwatch config test https://github.com/acme/shop/actions/runs/123   # which rules match that run, and whether it would reach you
prwatch watch-run https://github.com/acme/shop/actions/runs/123     # tell this pane when that run finishes, whoever started it
```

The menu bar app lists recent runs next to your pull requests, and **Rules…** opens the rules in effect with a button to edit each file.

State lives in `~/.prwatch` (`PRWATCH_HOME` to change it): `seen.json` for what has already been delivered, `runs.json` for the runs being followed and `status.json` for tools such as a menu bar app.

## Development

```sh
pnpm install
just check          # format, lint, typecheck, tests
./build.sh          # build/prwatch.app and a release zip (needs Bun and the Xcode command line tools)
```
