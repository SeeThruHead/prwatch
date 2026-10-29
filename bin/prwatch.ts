#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Duration, Effect, Layer, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import pkg from "../package.json" with { type: "json" }
import { GitHub } from "../src/GitHub.ts"
import { CmuxHost } from "../src/hosts/Cmux.ts"
import { HerdrHost } from "../src/hosts/Herdr.ts"
import { TmuxHost } from "../src/hosts/Tmux.ts"
import * as Bookkeeping from "../src/Bookkeeping.ts"
import { DEFAULT_INSTRUCTIONS, REVIEW_INSTRUCTIONS } from "../src/Message.ts"
import { Shell } from "../src/Shell.ts"
import { Store } from "../src/Store.ts"
import { Watcher } from "../src/Watcher.ts"
import { Workspace } from "../src/Workspace.ts"

const hostFlag = Flag.Literals("host", ["auto", "herdr", "cmux", "tmux"]).pipe(
  Flag.withDescription("where your agents run; auto picks the first that answers: herdr, cmux, then tmux"),
  Flag.withDefault("auto")
)
const dryRun = Flag.Boolean("dry-run").pipe(Flag.withDescription("print what would be sent instead of sending it"), Flag.withDefault(false))
const instructions = Flag.String("instructions").pipe(
  Flag.withDescription("the line appended to every message an agent gets"),
  Flag.withDefault(DEFAULT_INSTRUCTIONS)
)
const reviewInstructions = Flag.String("review-instructions").pipe(
  Flag.withDescription("the line appended to messages about pull requests you are reviewing"),
  Flag.withDefault(REVIEW_INSTRUCTIONS)
)
const interval = Flag.Int("interval").pipe(
  Flag.withDescription("seconds between full checks of every pull request"),
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(15))),
  Flag.withDefault(120)
)
const probe = Flag.Int("probe").pipe(
  Flag.withDescription("seconds between cheap checks for which pull requests changed; only those are fetched in full"),
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5))),
  Flag.withDefault(10)
)

type HostName = "auto" | "herdr" | "cmux" | "tmux"

const answers = (command: string, args: readonly string[]) =>
  Effect.flatMap(Shell, (shell) =>
    shell.run(command, args).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
  )

const detectHost = Effect.gen(function* () {
  if (yield* answers("herdr", ["agent", "list"])) return HerdrHost
  if (yield* answers("cmux", ["ping"])) return CmuxHost

  return TmuxHost
})

const hostLayer = (host: HostName) => {
  if (host === "herdr") return HerdrHost
  if (host === "cmux") return CmuxHost
  if (host === "tmux") return TmuxHost

  return Layer.unwrap(detectHost)
}

const watcherLayer = (host: HostName) =>
  Watcher.layer.pipe(Layer.provide(Layer.mergeAll(GitHub.layer, Workspace.layer, Store.layer, hostLayer(host))), Layer.provide(Shell.layer))

const run = Command.make(
  "run",
  { host: hostFlag, dryRun, instructions, reviewInstructions, interval, probe },
  ({ host, dryRun, instructions, reviewInstructions, interval, probe }) =>
    Effect.gen(function* () {
      const watcher = yield* Watcher
      yield* Console.log(`prwatch: checking which pull requests changed every ${probe}s, and all of them every ${interval}s`)
      return yield* watcher.watch({
        dryRun,
        instructions,
        reviewInstructions,
        interval: Duration.seconds(interval),
        probe: Duration.seconds(probe)
      })
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

const ack = Command.make("ack", { key: Argument.String("pull").pipe(Argument.withDescription("owner/name#number")) }, ({ key }) =>
  Effect.gen(function* () {
    const found = yield* Bookkeeping.acknowledge(key)
    yield* Console.log(found ? `${key} no longer needs you` : `${key} is not being watched`)
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("mark a pull request as seen so it stops showing as needing you"))

const pullKeys = Argument.String("pull").pipe(
  Argument.withDescription("owner/name#number, or a pull request URL"),
  Argument.variadic({ min: 1 })
)

const keyOf = (input: string) => {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(input)
  return url === null ? input : `${url[1]}#${url[2]}`
}

const callerPane = Effect.gen(function* () {
  const herdr = yield* Config.String("HERDR_PANE_ID").pipe(Config.withDefault(""))
  const cmux = yield* Config.String("CMUX_WORKSPACE_ID").pipe(Config.withDefault(""))
  const tmux = yield* Config.String("TMUX_PANE").pipe(Config.withDefault(""))

  return herdr || cmux || tmux
})

const agentFlag = Flag.String("agent").pipe(
  Flag.withDescription("the pane id to send to; defaults to the pane this runs in ($HERDR_PANE_ID, $CMUX_WORKSPACE_ID or $TMUX_PANE)"),
  Flag.withDefault("")
)

const claim = Command.make("claim", { pulls: pullKeys, agent: agentFlag }, ({ pulls, agent }) =>
  Effect.gen(function* () {
    const pane = agent || (yield* callerPane)
    if (pane === "") return yield* Console.error("prwatch claim: not inside a herdr or tmux pane; pass --agent <pane id>")

    const keys = pulls.map(keyOf)
    yield* Bookkeeping.claim(keys, pane)
    yield* Console.log(`${pane} now gets updates for ${keys.join(", ")}`)
  }).pipe(Effect.provide(Store.layer))
).pipe(Command.withDescription("send updates on these pull requests to this pane, wherever it is working"))

const release = Command.make("release", { pulls: pullKeys, agent: agentFlag }, ({ pulls, agent }) =>
  Effect.gen(function* () {
    const pane = agent || (yield* callerPane)
    const keys = pulls.map(keyOf)

    yield* Bookkeeping.release(keys, pane === "" ? undefined : pane)
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
  Command.withSubcommands([run, once, status, ack, claim, release, claims])
)

Command.run(prwatch, { version: pkg.version }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
