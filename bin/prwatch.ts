#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Duration, Effect, FileSystem, Layer, Option, Schedule, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import pkg from "../package.json" with { type: "json" }
import { PrKey, Text, agentId } from "../src/Brands.ts"
import { Activity } from "../src/Activity.ts"
import { RulesConfig } from "../src/Config.ts"
import { describeRule } from "../src/Describe.ts"
import { RunWatcher } from "../src/Runs.ts"
import { Pending } from "../src/RunState.ts"
import { GitHub } from "../src/GitHub.ts"
import { callerSession, withClaudeSessions } from "../src/hosts/Claude.ts"
import { CmuxHost } from "../src/hosts/Cmux.ts"
import { HerdrHost } from "../src/hosts/Herdr.ts"
import { OrcaHost } from "../src/hosts/Orca.ts"
import { TmuxHost } from "../src/hosts/Tmux.ts"
import * as Bookkeeping from "../src/Bookkeeping.ts"
import { DEFAULT_INSTRUCTIONS, REVIEW_INSTRUCTIONS } from "../src/Message.ts"
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

const runsInterval = Flag.Int("runs-interval").pipe(
  Flag.withDescription("seconds between checks of workflow runs, deployments and releases that your watch rules match"),
  Flag.withSchema(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(10)), Schema.brand("Seconds"))),
  Flag.withDefault(30)
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

const runsLayer = RunWatcher.layer.pipe(Layer.provide(Layer.mergeAll(RulesConfig.layer, Activity.layer, Store.layer)))

const watcherLayer = (host: HostChoice) =>
  Watcher.layer.pipe(
    Layer.provide(Layer.mergeAll(GitHub.layer, Workspace.layer, Store.layer, runsLayer, withClaudeSessions(hostLayer(host)))),
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
  { host: hostFlag, dryRun, instructions, reviewInstructions, interval, probe, runsInterval },
  ({ host, dryRun, instructions, reviewInstructions, interval, probe, runsInterval }) =>
    Effect.gen(function* () {
      const watcher = yield* Watcher
      yield* Console.log(`prwatch: checking which pull requests changed every ${probe}s, and all of them every ${interval}s`)
      const watching = watcher.watch({
        dryRun,
        instructions,
        reviewInstructions,
        interval: Duration.seconds(interval),
        probe: Duration.seconds(probe),
        runsEvery: Duration.seconds(runsInterval)
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
      const { pulls, runs } = yield* watcher.cycle({ dryRun, instructions, reviewInstructions })

      yield* Console.log(
        pulls.length === 0 && runs.length === 0 ? "nothing new" : `${pulls.length} pull requests and ${runs.length} runs had updates`
      )
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

const RUN_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/

class NotARunUrl extends Schema.TaggedError<NotARunUrl>()("NotARunUrl", { input: Text }) {
  override get message() {
    return `${this.input} is not a workflow run URL, like https://github.com/owner/name/actions/runs/123`
  }
}

const runPending = Effect.fn("prwatch.runPending")(function* (input: Text) {
  const url = RUN_URL.exec(input)
  if (url === null) return yield* new NotARunUrl({ input })

  return yield* Schema.decodeUnknownEffect(Pending)({
    key: `workflow_run:${url[1]}:${url[2]}`,
    source: "workflow_run",
    repo: url[1],
    ref: url[2]
  })
})

const runArgument = Argument.String("run").pipe(
  Argument.withDescription("a workflow run URL, like https://github.com/owner/name/actions/runs/123"),
  Argument.withSchema(Text)
)

const watchRun = Command.make("watch-run", { run: runArgument, agent: agentFlag }, ({ run, agent }) =>
  Effect.gen(function* () {
    const pane = agent || (yield* callerPane)
    if (pane === "") return yield* Console.error("prwatch watch-run: not inside a herdr, cmux, orca or tmux pane; pass --agent <pane id>")

    const pending = yield* runPending(run)
    yield* Bookkeeping.watchRun(pending, agentId(pane))
    yield* Console.log(`${pane} will hear when ${pending.key} finishes`)
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("tell this pane when a workflow run finishes, whoever started it"))

const configLayer = Layer.mergeAll(
  RulesConfig.layer,
  RunWatcher.layer.pipe(Layer.provide(Layer.mergeAll(RulesConfig.layer, Activity.layer, Store.layer)))
).pipe(Layer.provide(Shell.layer))

const configPath = Command.make("path", {}, () =>
  Effect.gen(function* () {
    const config = yield* RulesConfig
    yield* Console.log([`directory ${config.dir}`, `machine ${config.machine}`, ...config.files.map((file) => `file ${file}`)].join("\n"))
  }).pipe(Effect.provide(RulesConfig.layer))
).pipe(Command.withDescription("show where watch rules are read from and the machine name rules match against"))

const configShow = Command.make("show", { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) }, ({ json }) =>
  Effect.gen(function* () {
    const config = yield* RulesConfig
    if (json) {
      const fs = yield* FileSystem.FileSystem
      const files = yield* Effect.forEach(config.files, (path) =>
        Effect.map(
          Effect.orElseSucceed(fs.exists(path), () => false),
          (exists) => ({ path, exists })
        )
      )
      const loaded = yield* Effect.match(config.load, {
        onFailure: (error) => ({ rules: [], error: error.message }),
        onSuccess: (located) => ({ rules: located.map(({ rule, file }) => ({ file, rule, summary: describeRule(rule) })) })
      })

      return yield* Console.log(JSON.stringify({ directory: config.dir, machine: config.machine, files, ...loaded }, null, 2))
    }

    const located = yield* config.load
    if (located.length === 0) return yield* Console.log(`no watch rules; put them in ${config.files.join(" or ")}`)

    yield* Effect.forEach(located, ({ rule, file }) => Console.log(`${rule.name}  (${file})\n  ${describeRule(rule)}`), { discard: true })
  }).pipe(Effect.provide(RulesConfig.layer))
).pipe(Command.withDescription("list the watch rules in effect and the file each comes from"))

const configTest = Command.make("test", { run: runArgument }, ({ run }) =>
  Effect.gen(function* () {
    const runs = yield* RunWatcher
    const pending = yield* runPending(run)
    const explained = yield* runs.explain(pending)

    yield* Console.log(
      Option.match(explained.occurrence, {
        onNone: () => `${pending.key} was not found as ${explained.viewer}`,
        onSome: (occurrence) =>
          `${occurrence.key} ${occurrence.outcome} actor ${Option.getOrElse(occurrence.actor, () => "unknown")} (you are ${explained.viewer})`
      })
    )
    yield* Effect.forEach(
      explained.verdicts,
      (verdict) =>
        Console.log(
          `${verdict.rule.name}: ${verdict.matched ? "matches" : "does not match"}, ${Option.isSome(verdict.linked) ? "linked to you" : "not linked"}, ${verdict.wanted ? "this outcome is wanted" : "this outcome is not wanted"}`
        ),
      { discard: true }
    )
  }).pipe(Effect.provide(configLayer))
).pipe(Command.withDescription("show which watch rules match a run, and whether it would reach you"))

const config = Command.make("config").pipe(
  Command.withDescription("inspect the watch rules"),
  Command.withSubcommands([configPath, configShow, configTest])
)

const prwatch = Command.make("prwatch").pipe(
  Command.withDescription("hand new reviews, comments and CI results on your pull requests to the coding agent on that branch"),
  Command.withSubcommands([run, once, status, ack, claim, release, claims, watchRun, config])
)

Command.run(prwatch, { version: pkg.version }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
