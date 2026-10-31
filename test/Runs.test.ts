import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { ConfigProvider, DateTime, Effect, FileSystem, Layer, Option, Ref } from "effect"
import { describe, expect } from "vitest"

import { Activity } from "../src/Activity.ts"
import * as Bookkeeping from "../src/Bookkeeping.ts"
import { FilePath, agentId } from "../src/Brands.ts"
import { RulesConfig } from "../src/Config.ts"
import type { PullFact } from "../src/Linking.ts"
import type { Occurrence } from "../src/Occurrence.ts"
import { RunWatcher, advance, initial, sourcesByRepo } from "../src/Runs.ts"
import { Shell } from "../src/Shell.ts"
import { Store } from "../src/Store.ts"
import { Stdout } from "../src/Brands.ts"
import { host, me, merged, repo, rule, run } from "./runs.ts"

const fakeShell = (answer: string) => Layer.succeed(Shell, Shell.of({ run: () => Effect.succeed(Stdout.make(answer)) }))

const harness = (
  rules: readonly ReturnType<typeof rule>[],
  current: Ref.Ref<readonly Occurrence[]>,
  pulls: readonly PullFact[] = [],
  shell = fakeShell("{}")
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ directory: "node_modules" })
    const config = Layer.succeed(
      RulesConfig,
      RulesConfig.of({
        dir: FilePath.make(dir),
        machine: host,
        files: [],
        load: Effect.succeed(rules.map((entry) => ({ rule: entry, file: FilePath.make(`${dir}/config.json`) })))
      })
    )
    const activity = Layer.succeed(
      Activity,
      Activity.of({
        viewer: Effect.succeed(me),
        repos: () => Effect.succeed([repo]),
        occurrencesSince: () => Ref.get(current),
        refresh: (pending) => Effect.map(Ref.get(current), (list) => Option.fromNullishOr(list.find((entry) => entry.key === pending.key))),
        pulls: () => Effect.succeed(pulls)
      })
    )
    const store = Store.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PRWATCH_HOME: dir }))))

    return Layer.mergeAll(RunWatcher.layer.pipe(Layer.provide(Layer.mergeAll(config, activity, store, shell))), store)
  })

const provided = <A, E>(
  rules: readonly ReturnType<typeof rule>[],
  current: Ref.Ref<readonly Occurrence[]>,
  program: Effect.Effect<A, E, RunWatcher | Store>,
  pulls: readonly PullFact[] = [],
  shell = fakeShell("{}")
) => Effect.flatMap(harness(rules, current, pulls, shell), (layer) => Effect.provide(program, layer))

const collectNow = Effect.flatMap(RunWatcher, (watcher) => watcher.collect({ dryRun: false }))

const deploys = rule({ name: "deploys", branches: ["main"], link: "merge-commit", notify: { on: ["succeeded"], to: ["pane", "menubar"] } })

describe("advance", () => {
  it("records what was seen, tracks what is still running, and forgets what finished", () => {
    const now = DateTime.makeUnsafe("2026-01-02T00:00:00Z")
    const running = run({ status: "in_progress", conclusion: null })
    const first = advance(initial(now), [running], [running], [], now)

    expect(Object.keys(first.pending)).toEqual([running.key])
    expect(first.seen[running.key]?.outcome).toBe("started")

    const second = advance(first, [run()], [], [], now)

    expect(second.pending).toEqual({})
    expect(second.seen[running.key]?.outcome).toBe("succeeded")
  })

  it("moves the window back by a margin and drops watches that are done", () => {
    const now = DateTime.makeUnsafe("2026-01-02T00:00:00Z")
    const watched = { ...initial(now), watches: { [run().key]: { pending: run().pending, agents: [agentId("w1:p1")] } } }

    expect(advance(watched, [], [], [run().key], now).watches).toEqual({})
    expect(advance(watched, [], [], [], now).since).toBe("2026-01-01T23:50:00.000Z")
  })
})

describe("sourcesByRepo", () => {
  it("lists each repo once with every source a rule wants from it", () => {
    const planned = [
      { rule: rule({ source: "deployment" }), repos: [repo] },
      { rule: rule(), repos: [repo] },
      { rule: rule({ source: "deployment" }), repos: [repo] }
    ]

    expect(sourcesByRepo(planned)).toEqual([{ repo, sources: ["deployment", "workflow_run"], actorOnly: false }])
  })
})

describe("RunWatcher.collect", () => {
  it.effect("does nothing, and writes nothing, when there are no rules", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make<readonly Occurrence[]>([run()])
        const result = yield* provided(
          [],
          current,
          Effect.gen(function* () {
            const collected = yield* (yield* RunWatcher).collect({ dryRun: false })
            return { collected, stored: yield* (yield* Store).runs }
          })
        )

        expect(result.collected.deliveries).toEqual([])
        expect(result.stored).toBeUndefined()
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("delivers a main deploy of your merged pull request once, to the panes and the menu bar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make<readonly Occurrence[]>([run()])
        const both = yield* provided(
          [deploys],
          current,
          Effect.gen(function* () {
            const watcher = yield* RunWatcher
            return [yield* watcher.collect({ dryRun: false }), yield* watcher.collect({ dryRun: false })] as const
          }),
          [merged()]
        )
        const [first, again] = both

        expect(first.deliveries.map((delivery) => [delivery.occurrence.key, delivery.targets, delivery.linked.pr])).toEqual([
          ["workflow_run:acme/shop:101", ["pane", "menubar"], Option.some("acme/shop#7")]
        ])
        expect(first.recent.map((entry) => [entry.rule, entry.needsYou])).toEqual([["deploys", false]])
        expect(again.deliveries).toEqual([])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("stays quiet about runs that are not linked to you", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make<readonly Occurrence[]>([run()])
        const collected = yield* provided([deploys], current, collectNow, [])

        expect(collected.deliveries).toEqual([])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("keeps following a run that is still going and delivers when it finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const running = run({ status: "in_progress", conclusion: null })
        const current = yield* Ref.make<readonly Occurrence[]>([running])
        const outcomes = yield* provided(
          [deploys],
          current,
          Effect.gen(function* () {
            const watcher = yield* RunWatcher
            const during = yield* watcher.collect({ dryRun: false })
            yield* Ref.set(current, [run()])
            const after = yield* watcher.collect({ dryRun: false })
            return [during.deliveries.length, after.deliveries.map((delivery) => delivery.occurrence.outcome)] as const
          }),
          [merged()]
        )

        expect(outcomes).toEqual([0, ["succeeded"]])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("adds the pane of a watcher to the targets of a rule that also matches the run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make<readonly Occurrence[]>([run()])
        const collected = yield* provided(
          [rule({ name: "menubar only", link: "any", notify: { to: ["menubar"] } })],
          current,
          Effect.gen(function* () {
            yield* Bookkeeping.watchRun(run().pending, agentId("w1:p1"))
            return yield* collectNow
          })
        )

        expect(collected.deliveries.map((delivery) => [delivery.targets, delivery.watchers])).toEqual([[["menubar", "pane"], ["w1:p1"]]])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("tells a pane that watched a run when it finishes, without any rule", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make<readonly Occurrence[]>([run({ conclusion: "failure" })])
        const collected = yield* provided(
          [],
          current,
          Effect.gen(function* () {
            yield* Bookkeeping.watchRun(run().pending, agentId("w1:p1"))
            return yield* (yield* RunWatcher).collect({ dryRun: false })
          })
        )

        expect(collected.deliveries.map((delivery) => [delivery.watchers, delivery.targets, delivery.linked.claimantsOnly])).toEqual([
          [["w1:p1"], ["pane"], true]
        ])
        expect(collected.recent.map((entry) => entry.needsYou)).toEqual([true])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("lets a command veto a delivery and add a line to the message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hooked = rule({ name: "hooked", link: "any", command: "decide" })
        const current = yield* Ref.make<readonly Occurrence[]>([run()])
        const vetoed = yield* provided([hooked], current, collectNow, [], fakeShell('{"linked":false}'))
        const second = yield* Ref.make<readonly Occurrence[]>([run()])
        const kept = yield* provided([hooked], second, collectNow, [], fakeShell('{"linked":true,"message":"rolled back"}'))

        expect(vetoed.deliveries).toEqual([])
        expect(kept.deliveries.map((delivery) => delivery.message)).toEqual([Option.some("rolled back")])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("does not save state on a dry run, so the same run is delivered again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make<readonly Occurrence[]>([run()])
        const counts = yield* provided(
          [deploys],
          current,
          Effect.gen(function* () {
            const watcher = yield* RunWatcher
            const first = yield* watcher.collect({ dryRun: true })
            const second = yield* watcher.collect({ dryRun: true })
            return [first.deliveries.length, second.deliveries.length] as const
          }),
          [merged()]
        )

        expect(counts).toEqual([1, 1])
      })
    ).pipe(Effect.provide(NodeServices.layer))
  )
})
