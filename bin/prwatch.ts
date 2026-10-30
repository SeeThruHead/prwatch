#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import pkg from "../package.json" with { type: "json" }
import { PrKey, Text, Url, agentId, repoSlug } from "../src/Brands.ts"
import { GitHub } from "../src/GitHub.ts"
import { callerSession, withClaudeSessions } from "../src/hosts/Claude.ts"
import { CmuxHost } from "../src/hosts/Cmux.ts"
import { HerdrHost } from "../src/hosts/Herdr.ts"
import { OrcaHost } from "../src/hosts/Orca.ts"
import { TmuxHost } from "../src/hosts/Tmux.ts"
import * as Bookkeeping from "../src/Bookkeeping.ts"
import { Host } from "../src/Host.ts"
import { DEFAULT_INSTRUCTIONS, REVIEW_INSTRUCTIONS, START_PROMPT, startMessage } from "../src/Message.ts"
import { Shell } from "../src/Shell.ts"
import { Store } from "../src/Store.ts"
import { Watcher } from "../src/Watcher.ts"
import { Workspace } from "../src/Workspace.ts"

const hostFlag = Flag.Literals("host", ["auto", "herdr", "cmux", "orca", "tmux"]).pipe(
  Flag.withDescription("where your agents run; auto picks the first that answers: herdr, cmux, orca, then tmux"),
  Flag.withDefault("auto")
)
const dryRun = Flag.Boolean("dry-run").pipe(Flag.withDescription("print what would be sent instead of sending it"), Flag.withDefault(false))
const instructions = Flag.String("instructions").pipe(
  Flag.withDescription("the line appended to every message an agent gets"),
  Flag.withSchema(Text),
  Flag.withDefault(DEFAULT_INSTRUCTIONS)
)
const reviewInstructions = Flag.String("review-instructions").pipe(
  Flag.withDescription("the line appended to messages about pull requests you are reviewing"),
  Flag.withSchema(Text),
  Flag.withDefault(REVIEW_INSTRUCTIONS)
)
const interval = Flag.Int("interval").pipe(
  Flag.withDescription("seconds between full checks of every pull request"),
  Flag.withSchema(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(15)), Schema.brand("Seconds"))),
  Flag.withDefault(120)
)
const probe = Flag.Int("probe").pipe(
  Flag.withDescription("seconds between cheap checks for which pull requests changed; only those are fetched in full"),
  Flag.withSchema(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(5)), Schema.brand("Seconds"))),
  Flag.withDefault(10)
)

type HostChoice = "auto" | "herdr" | "cmux" | "orca" | "tmux"

const answers = (command: "herdr" | "cmux" | "orca", args: readonly ("agent" | "list" | "ping" | "terminal" | "--json")[]) =>
  Effect.flatMap(Shell, (shell) =>
    shell.run(command, args).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
  )

const detectHost = Effect.gen(function* () {
  if (yield* answers("herdr", ["agent", "list"])) return HerdrHost
  if (yield* answers("cmux", ["ping"])) return CmuxHost
  if (yield* answers("orca", ["terminal", "list", "--json"])) return OrcaHost

  return TmuxHost
})

const hostLayer = (host: HostChoice) => {
  if (host === "herdr") return HerdrHost
  if (host === "cmux") return CmuxHost
  if (host === "orca") return OrcaHost
  if (host === "tmux") return TmuxHost

  return Layer.unwrap(detectHost)
}

const watcherLayer = (host: HostChoice) =>
  Watcher.layer.pipe(
    Layer.provide(Layer.mergeAll(GitHub.layer, Workspace.layer, Store.layer, withClaudeSessions(hostLayer(host)))),
    Layer.provide(Shell.layer)
  )

const isAlive = (pid: typeof process.ppid) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

const parentExited = Effect.gen(function* () {
  const parent = process.ppid
  if (parent === 1) return yield* Effect.never

  yield* Effect.sync(() => isAlive(parent)).pipe(Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (alive) => !alive }))
  yield* Console.log("prwatch: the process that started this one exited, stopping")
})

const run = Command.make(
  "run",
  { host: hostFlag, dryRun, instructions, reviewInstructions, interval, probe },
  ({ host, dryRun, instructions, reviewInstructions, interval, probe }) =>
    Effect.gen(function* () {
      const watcher = yield* Watcher
      yield* Console.log(`prwatch: checking which pull requests changed every ${probe}s, and all of them every ${interval}s`)
      const watching = watcher.watch({
        dryRun,
        instructions,
        reviewInstructions,
        interval: Duration.seconds(interval),
        probe: Duration.seconds(probe)
      })
      return yield* Effect.raceFirst(watching, parentExited)
    }).pipe(Effect.provide(watcherLayer(host)))
).pipe(Command.withDescription("watch your pull requests and hand each change to the agent on that branch"))

const once = Command.make(
  "once",
  { host: hostFlag, dryRun, instructions, reviewInstructions },
  ({ host, dryRun, instructions, reviewInstructions }) =>
    Effect.gen(function* () {
      const watcher = yield* Watcher
      const deliveries = yield* watcher.cycle({ dryRun, instructions, reviewInstructions })

      yield* Console.log(deliveries.length === 0 ? "nothing new" : `${deliveries.length} pull requests had updates`)
    }).pipe(Effect.provide(watcherLayer(host)))
).pipe(Command.withDescription("check once; the first run only records what exists so far"))

const status = Command.make("status", { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const current = yield* store.status
    if (current === undefined) return yield* Console.log("no status yet: run prwatch once or prwatch run")
    if (json) return yield* Console.log(JSON.stringify(current, null, 2))

    yield* Console.log(
      `updated ${current.updatedAt} via ${current.host}${current.error === undefined ? "" : `\nlast error: ${current.error}`}`
    )
    yield* Effect.forEach(
      current.pulls,
      (pull) => Console.log(`${pull.needsYou ? "●" : " "} ${pull.key} ${pull.title}${pull.last === undefined ? "" : `\n    ${pull.last}`}`),
      { discard: true }
    )
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("show the pull requests being watched and which need you"))

const PULL_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

const pullKey = (input: Text) => {
  const url = PULL_URL.exec(input)
  return Schema.decodeUnknownEffect(PrKey)(url === null ? input : `${url[1]}#${url[2]}`)
}

const pullArgument = Argument.String("pull").pipe(
  Argument.withDescription("owner/name#number, or a pull request URL"),
  Argument.withSchema(Text)
)

const ack = Command.make("ack", { pull: pullArgument }, ({ pull }) =>
  Effect.gen(function* () {
    const key = yield* pullKey(pull)
    const found = yield* Bookkeeping.acknowledge(key)
    yield* Console.log(found ? `${key} no longer needs you` : `${key} is not being watched`)
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("mark a pull request as seen so it stops showing as needing you"))

const check = Command.make(
  "check",
  { pull: pullArgument, host: hostFlag, dryRun, instructions, reviewInstructions },
  ({ pull, host, dryRun, instructions, reviewInstructions }) =>
    Effect.gen(function* () {
      const key = yield* pullKey(pull)
      const watcher = yield* Watcher
      const agents = yield* watcher.check(key, { dryRun, instructions, reviewInstructions })

      if (Option.isNone(agents)) return yield* Console.log(`${key} is not being watched`)
      yield* Console.log(
        agents.value.length === 0 ? "no agent on this branch" : `asked ${agents.value.map((agent) => agent.label).join(", ")}`
      )
    }).pipe(Effect.provide(watcherLayer(host)))
).pipe(Command.withDescription("ask the agent on this pull request's branch whether its review comments are resolved"))

const startPrompt = Flag.String("prompt").pipe(
  Flag.withDescription(
    "what the new agent is asked to do, after the pull request link; defaults to $PRWATCH_START_PROMPT, then a check of which review comments are resolved"
  ),
  Flag.withSchema(Text),
  Flag.withDefault(Text.make(""))
)

const start = Command.make(
  "start",
  { pull: pullArgument, host: hostFlag, prompt: startPrompt, instructions },
  ({ pull, host, prompt, instructions }) =>
    Effect.gen(function* () {
      const ask = prompt || Text.make(yield* Config.String("PRWATCH_START_PROMPT").pipe(Config.withDefault(START_PROMPT)))
      const key = yield* pullKey(pull)
      const hash = key.lastIndexOf("#")
      const repo = repoSlug(key.slice(0, hash))
      const url = Url.make(`https://github.com/${repo}/pull/${key.slice(hash + 1)}`)
      const agents = yield* Host
      if (agents.start === undefined) return yield* Console.log(`${agents.name} cannot start agents`)

      const where = yield* agents.start(repo, startMessage(url, ask, instructions))
      yield* Console.log(`started ${where}`)
    }).pipe(Effect.provide(withClaudeSessions(hostLayer(host)).pipe(Layer.provide(Shell.layer))))
).pipe(Command.withDescription("start an agent that checks which review comments on this pull request are resolved"))

const pullKeys = pullArgument.pipe(Argument.variadic({ min: 1 }))

const callerPane = Effect.gen(function* () {
  const session = yield* callerSession
  if (Option.isSome(session)) return session.value

  const herdr = yield* Config.String("HERDR_PANE_ID").pipe(Config.withDefault(""))
  const cmux = yield* Config.String("CMUX_WORKSPACE_ID").pipe(Config.withDefault(""))
  const orca = yield* Config.String("ORCA_TERMINAL_HANDLE").pipe(Config.withDefault(""))
  const tmux = yield* Config.String("TMUX_PANE").pipe(Config.withDefault(""))

  return herdr || cmux || orca || tmux
})

const agentFlag = Flag.String("agent").pipe(
  Flag.withDescription(
    "the agent to send to; defaults to the Claude Code session this runs in, then the pane ($HERDR_PANE_ID, $CMUX_WORKSPACE_ID, $ORCA_TERMINAL_HANDLE or $TMUX_PANE)"
  ),
  Flag.withDefault("")
)

const claim = Command.make("claim", { pulls: pullKeys, agent: agentFlag }, ({ pulls, agent }) =>
  Effect.gen(function* () {
    const pane = agent || (yield* callerPane)
    if (pane === "") return yield* Console.error("prwatch claim: not inside a herdr, cmux, orca or tmux pane; pass --agent <pane id>")

    const keys = yield* Effect.forEach(pulls, pullKey)
    yield* Bookkeeping.claim(keys, agentId(pane))
    yield* Console.log(`${pane} now gets updates for ${keys.join(", ")}`)
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("send updates on these pull requests to this pane, wherever it is working"))

const release = Command.make("release", { pulls: pullKeys, agent: agentFlag }, ({ pulls, agent }) =>
  Effect.gen(function* () {
    const pane = agent || (yield* callerPane)
    const keys = yield* Effect.forEach(pulls, pullKey)

    yield* Bookkeeping.release(keys, pane === "" ? undefined : agentId(pane))
    yield* Console.log(`released ${keys.join(", ")}${pane === "" ? " for every pane" : ` for ${pane}`}`)
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("stop sending these pull requests to this pane"))

const claims = Command.make("claims", {}, () =>
  Effect.gen(function* () {
    const store = yield* Store
    const current = yield* store.claims
    const lines = Object.entries(current).flatMap(([key, entries]) => entries.map((entry) => `${key}  ${entry.agent}  since ${entry.at}`))

    yield* Console.log(lines.length === 0 ? "no claims" : lines.join("\n"))
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("list which panes asked for which pull requests"))

const prwatch = Command.make("prwatch").pipe(
  Command.withDescription("hand new reviews, comments and CI results on your pull requests to the coding agent on that branch"),
  Command.withSubcommands([run, once, status, ack, check, start, claim, release, claims])
)

Command.run(prwatch, { version: pkg.version }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
