import { Array as Arr, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"

import {
  type AgentId,
  type IsoTime,
  type Login,
  type NotifyTarget,
  PrKey,
  type RepoSlug,
  type RuleName,
  type RunKey,
  type SourceKind,
  Text,
  isoTime
} from "./Brands.ts"
import { Activity, type ActivityUnavailable } from "./Activity.ts"
import { distinct, firstBy } from "./Fields.ts"
import { type Located, RulesConfig, type RulesInvalid, activeOn } from "./Config.ts"
import type { Linked } from "./Linking.ts"
import { type Occurrence, isFinished } from "./Occurrence.ts"
import { type Verdict, evaluate, pullsNeeded, route, wanted } from "./Routing.ts"
import type { Pending, RunState, StatusRun } from "./RunState.ts"
import type { Rule } from "./Rules.ts"
import { Shell } from "./Shell.ts"
import { Store } from "./Store.ts"

export type RunDelivery = {
  readonly occurrence: Occurrence
  readonly rule: Option.Option<RuleName>
  readonly linked: Linked
  readonly targets: readonly NotifyTarget[]
  readonly message: Option.Option<Text>
  readonly watchers: readonly AgentId[]
}

export type Collected = { readonly deliveries: readonly RunDelivery[]; readonly recent: readonly StatusRun[] }

export type Explained = {
  readonly viewer: Login
  readonly occurrence: Option.Option<Occurrence>
  readonly verdicts: readonly Verdict[]
  readonly files: readonly Located[]
}

const SEEN_FOR = Duration.days(3)
const MARGIN = Duration.minutes(10)
const LOOKBACK = Duration.days(1)
const CONCURRENCY = 4
const WATCHED_TARGETS: readonly NotifyTarget[] = ["pane"]

const HookAnswer = Schema.Struct({ linked: Schema.Boolean, pr: Schema.optionalKey(PrKey), message: Schema.optionalKey(Text) })

export const initial = (now: DateTime.Utc): RunState => ({ since: isoTime(now), seen: {}, pending: {}, watches: {} })

export const advance = (
  state: RunState,
  examined: readonly Occurrence[],
  tracked: readonly Occurrence[],
  watchesDone: readonly RunKey[],
  now: DateTime.Utc
): RunState => {
  const cutoff = isoTime(DateTime.subtractDuration(now, SEEN_FOR))
  const finished = new Set<RunKey>(examined.filter(isFinished).map((occurrence) => occurrence.key))
  const done = new Set<RunKey>(watchesDone)

  return {
    since: isoTime(DateTime.subtractDuration(now, MARGIN)),
    seen: {
      ...Object.fromEntries(Object.entries(state.seen).filter(([, entry]) => entry.at >= cutoff)),
      ...Object.fromEntries(examined.map((occurrence) => [occurrence.key, { outcome: occurrence.outcome, at: occurrence.at }]))
    },
    pending: {
      ...Object.fromEntries(
        Object.values(state.pending)
          .filter((pending) => !finished.has(pending.key))
          .map((pending) => [pending.key, pending])
      ),
      ...Object.fromEntries(tracked.map((occurrence) => [occurrence.key, occurrence.pending]))
    },
    watches: Object.fromEntries(
      Object.values(state.watches)
        .filter((watch) => !done.has(watch.pending.key))
        .map((watch) => [watch.pending.key, watch])
    )
  }
}

export const sourcesByRepo = (
  planned: readonly { readonly rule: Rule; readonly repos: readonly RepoSlug[] }[]
): readonly { readonly repo: RepoSlug; readonly sources: readonly SourceKind[]; readonly actorOnly: boolean }[] => {
  const entries = planned.flatMap(({ rule, repos }) =>
    repos.map((repo) => ({ repo, source: rule.source ?? "workflow_run", link: rule.link }))
  )

  return Object.values(Arr.groupBy(entries, (entry) => entry.repo)).map((group) => ({
    repo: group[0].repo,
    sources: distinct(group.map((entry) => entry.source)),
    actorOnly: group.filter((entry) => entry.source === "workflow_run").every((entry) => entry.link === "actor")
  }))
}

export const statusRun = (delivery: RunDelivery): StatusRun => ({
  key: delivery.occurrence.key,
  title: delivery.occurrence.title,
  url: delivery.occurrence.url,
  outcome: delivery.occurrence.outcome,
  ...Option.match(delivery.rule, { onNone: () => ({}), onSome: (rule) => ({ rule }) }),
  at: delivery.occurrence.at,
  needsYou: delivery.occurrence.outcome === "failed"
})

const ruleDelivery = (
  rule: Rule,
  occurrence: Occurrence,
  linked: Linked,
  message: Option.Option<Text>,
  watchers: readonly AgentId[]
): RunDelivery => ({
  occurrence,
  rule: Option.some(rule.name),
  linked,
  targets: watchers.length > 0 ? distinct([...rule.notify.to, ...WATCHED_TARGETS]) : rule.notify.to,
  message,
  watchers
})

const watchDelivery = (occurrence: Occurrence, watchers: readonly AgentId[]): Option.Option<RunDelivery> => {
  if (watchers.length === 0) return Option.none()
  if (!isFinished(occurrence)) return Option.none()

  return Option.some({
    occurrence,
    rule: Option.none(),
    linked: { pr: Option.none(), branch: occurrence.branch, sha: occurrence.sha, claimantsOnly: true },
    targets: WATCHED_TARGETS,
    message: Option.none(),
    watchers
  })
}

export class RunWatcher extends Context.Service<
  RunWatcher,
  {
    readonly collect: (options: { readonly dryRun: boolean }) => Effect.Effect<Collected>
    readonly explain: (pending: Pending) => Effect.Effect<Explained, RulesInvalid | ActivityUnavailable>
  }
>()("prwatch/RunWatcher") {
  static readonly layer = Layer.effect(
    RunWatcher,
    Effect.gen(function* () {
      const config = yield* RulesConfig
      const activity = yield* Activity
      const store = yield* Store
      const shell = yield* Shell

      const warn = (error: Error) => Effect.logWarning(error.message)

      const orLog = <A, E extends Error, R>(effect: Effect.Effect<A, E, R>, fallback: A) =>
        effect.pipe(
          Effect.tapError(warn),
          Effect.orElseSucceed(() => fallback)
        )

      const pullsFor = Effect.fn("RunWatcher.pullsFor")(function* (rules: readonly Rule[], occurrence: Occurrence) {
        if (!pullsNeeded(rules, occurrence, config.machine)) return []

        return yield* orLog(activity.pulls(occurrence.repo, occurrence.sha), [])
      })

      const hook = Effect.fn("RunWatcher.hook")(function* (rule: Rule, occurrence: Occurrence, linked: Linked, viewer: Login) {
        if (rule.command === undefined) return Option.some({ linked, message: Option.none<Text>() })

        const payload = JSON.stringify({
          rule: rule.name,
          viewer,
          builtin: { pr: Option.getOrNull(linked.pr), branch: Option.getOrNull(linked.branch), sha: linked.sha },
          occurrence: { ...occurrence, branch: Option.getOrNull(occurrence.branch), actor: Option.getOrNull(occurrence.actor) }
        })
        const answer = yield* shell
          .run("sh", ["-c", rule.command], { stdin: payload })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HookAnswer))), Effect.tapError(warn), Effect.option)

        return Option.flatMap(answer, (found) => {
          if (!found.linked) return Option.none()

          return Option.some({
            linked: { ...linked, pr: found.pr === undefined ? linked.pr : Option.some(found.pr) },
            message: Option.fromNullishOr(found.message)
          })
        })
      })

      const decide = Effect.fn("RunWatcher.decide")(function* (
        rules: readonly Rule[],
        state: RunState,
        viewer: Login,
        occurrence: Occurrence
      ) {
        const watchers = state.watches[occurrence.key]?.agents ?? []
        const routed = route(evaluate(rules, occurrence, config.machine, { viewer, pulls: yield* pullsFor(rules, occurrence) }))
        const hooked = yield* Option.match(routed, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: ({ rule, linked }) => hook(rule, occurrence, linked, viewer)
        })
        const byRule = Option.flatMap(routed, ({ rule }) =>
          wanted(rule, occurrence.outcome)
            ? Option.map(hooked, (answer) => ruleDelivery(rule, occurrence, answer.linked, answer.message, watchers))
            : Option.none()
        )

        return {
          occurrence,
          tracked: Option.isSome(routed) || watchers.length > 0,
          delivery: Option.orElse(byRule, () => watchDelivery(occurrence, watchers))
        }
      })

      const listed = Effect.fn("RunWatcher.listed")(function* (rules: readonly Rule[], since: IsoTime, viewer: Login) {
        const expanded = yield* orLog(
          Effect.forEach(rules, (rule) => Effect.map(activity.repos(rule.repos), (repos) => ({ rule, repos })), {
            concurrency: CONCURRENCY
          }),
          []
        )
        const found = yield* Effect.forEach(
          sourcesByRepo(expanded),
          ({ repo, sources, actorOnly }) => orLog(activity.occurrencesSince(repo, sources, since, viewer, actorOnly), []),
          { concurrency: CONCURRENCY }
        )

        return found.flat()
      })

      const refreshed = Effect.fn("RunWatcher.refreshed")(function* (state: RunState) {
        const open = [...Object.values(state.pending), ...Object.values(state.watches).map((watch) => watch.pending)]
        const found = yield* Effect.forEach(
          firstBy(open, (pending) => pending.key),
          (pending) => orLog(Effect.map(activity.refresh(pending), Option.toArray), []),
          { concurrency: CONCURRENCY }
        )

        return found.flat()
      })

      const collect = Effect.fn("RunWatcher.collect")(function* (options: { readonly dryRun: boolean }) {
        const located = yield* orLog(config.load, [])
        const rules = activeOn(config.machine)(located).map((entry) => entry.rule)
        const now = yield* DateTime.now
        const state = (yield* store.runs) ?? initial(now)
        if (rules.length === 0 && Object.keys(state.watches).length === 0) return { deliveries: [], recent: [] }

        const viewer = yield* activity.viewer.pipe(Effect.tapError(warn), Effect.option)
        if (Option.isNone(viewer)) return { deliveries: [], recent: [] }

        const floor = isoTime(DateTime.subtractDuration(now, LOOKBACK))
        const occurrences = firstBy(
          [...(yield* refreshed(state)), ...(yield* listed(rules, state.since > floor ? state.since : floor, viewer.value))],
          (occurrence) => occurrence.key
        )
        const changed = occurrences.filter((occurrence) => state.seen[occurrence.key]?.outcome !== occurrence.outcome)
        const decisions = yield* Effect.forEach(changed, (occurrence) => decide(rules, state, viewer.value, occurrence), {
          concurrency: CONCURRENCY
        })
        const deliveries = decisions.flatMap((decision) => Option.toArray(decision.delivery))
        const tracked = decisions
          .filter((decision) => decision.tracked && !isFinished(decision.occurrence))
          .map((decision) => decision.occurrence)
        const done = decisions.filter((decision) => isFinished(decision.occurrence)).map((decision) => decision.occurrence.key)

        if (!options.dryRun) yield* store.saveRuns(advance(state, changed, tracked, done, now)).pipe(Effect.tapError(warn), Effect.ignore)

        return { deliveries, recent: deliveries.map(statusRun) }
      })

      const explain = Effect.fn("RunWatcher.explain")(function* (pending: Pending) {
        const located = yield* config.load
        const rules = located.map((entry) => entry.rule)
        const viewer = yield* activity.viewer
        const occurrence = yield* activity.refresh(pending)
        const pulls = yield* Option.match(occurrence, { onNone: () => Effect.succeed([]), onSome: (found) => pullsFor(rules, found) })
        const verdicts = Option.match(occurrence, {
          onNone: (): readonly Verdict[] => [],
          onSome: (found) => evaluate(rules, found, config.machine, { viewer, pulls })
        })

        return { viewer, occurrence, verdicts, files: located }
      })

      return RunWatcher.of({ collect, explain })
    })
  )
}
