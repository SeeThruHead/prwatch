import { Context, DateTime, Duration, Effect, Layer, Option, Predicate, Ref, Schedule } from "effect"

import { type Change, type Seen, changesSince, needsYou, snapshotOf } from "./Changes.ts"
import { GitHub, type PullRequest, type Stamp } from "./GitHub.ts"
import { type Agent, Host } from "./Host.ts"
import { type Branch, Count, type HostName, type IsoTime, type RepoSlug, type Sha, Text, isoTime, sameRepo } from "./Brands.ts"
import { agentMessage, notification, summary } from "./Message.ts"
import { type Claims, type Status, type StatusPull, Store } from "./Store.ts"
import { Workspace } from "./Workspace.ts"

export type Placed = Agent & { readonly repo: RepoSlug; readonly branch: Option.Option<Branch>; readonly commit: Sha }

type Delivery = {
  readonly pull: PullRequest
  readonly changes: readonly Change[]
  readonly agents: readonly Agent[]
  readonly needsYou: boolean
}

const PR_BRANCH = /^pr[-/]?(\d+)$/

const branchMatches = (pull: PullRequest, branch: Branch) => {
  if (branch === pull.branch) return true

  return PR_BRANCH.exec(branch)?.[1] === String(pull.number)
}

export const onBranch = (pull: PullRequest) => (agent: Placed) => {
  if (!sameRepo(agent.repo, pull.repo)) return false
  if (Option.exists(agent.branch, (branch) => branchMatches(pull, branch))) return true

  return Option.isNone(agent.branch) && pull.commits.includes(agent.commit)
}

const reachable = (agent: Agent) => agent.status !== "blocked"

type Found = { readonly agents: readonly Agent[]; readonly placed: readonly Placed[] }

export const recipients = (pull: PullRequest, found: Found, claims: Claims): readonly Agent[] => {
  const claimed = new Set((claims[pull.key] ?? []).map((claim) => claim.agent))
  const byClaim = found.agents.filter((agent) => claimed.has(agent.id))
  const byWorktree = found.placed.filter(onBranch(pull)).filter((agent) => !claimed.has(agent.id))

  return [...byClaim, ...byWorktree].filter(reachable)
}

const plan = (pulls: readonly PullRequest[], seen: Seen | undefined, found: Found, claims: Claims): readonly Delivery[] =>
  pulls.flatMap((pull) => {
    const changes = changesSince(pull, seen?.[pull.key])
    if (changes.length === 0) return []

    return [{ pull, changes, agents: recipients(pull, found, claims), needsYou: changes.some(needsYou) }]
  })

export const liveClaims = (claims: Claims, pulls: readonly PullRequest[], agents: readonly Agent[]): Claims => {
  const present = new Set(agents.map((agent) => agent.id))

  return Object.fromEntries(
    Object.entries(claims)
      .filter(([key]) => pulls.some((pull) => pull.key === key))
      .map(([key, entries]) => [key, entries.filter((entry) => present.has(entry.agent))] as const)
      .filter(([, entries]) => entries.length > 0)
  )
}

const nextSeen = (pulls: readonly PullRequest[], seen: Seen | undefined): Seen =>
  Object.fromEntries(pulls.map((pull) => [pull.key, snapshotOf(pull, seen?.[pull.key])]))

const latest = (delivery: Delivery | undefined, before: StatusPull | undefined, at: IsoTime) => {
  if (delivery !== undefined) return { last: summary(delivery.changes), lastAt: at }
  if (before?.last === undefined) return {}

  return { last: before.last, lastAt: before.lastAt ?? at }
}

export const statsOf = (pull: PullRequest) => ({
  role: pull.role,
  draft: pull.draft,
  checks: pull.checks,
  decision: pull.decision,
  mergeable: pull.mergeable,
  comments: Count.make(pull.items.filter((item) => !item.bot).length)
})

const nextStatus = (
  previous: Status | undefined,
  pulls: readonly PullRequest[],
  deliveries: readonly Delivery[],
  host: HostName,
  at: IsoTime
): Status => ({
  updatedAt: at,
  host,
  pulls: pulls.map((pull) => {
    const before = previous?.pulls.find((entry) => entry.key === pull.key)
    const delivery = deliveries.find((entry) => entry.pull.key === pull.key)
    const agent = delivery?.agents[0]?.label ?? before?.agent
    const agentId = delivery?.agents[0]?.id ?? before?.agentId

    return {
      key: pull.key,
      title: pull.title,
      url: pull.url,
      needsYou: delivery?.needsYou === true || before?.needsYou === true,
      ...latest(delivery, before, at),
      ...(agent === undefined ? {} : { agent }),
      ...(agentId === undefined ? {} : { agentId }),
      ...statsOf(pull)
    }
  })
})

export type Synced = { readonly at: DateTime.Utc; readonly stamps: readonly Stamp[]; readonly pulls: readonly PullRequest[] }

export const movedSince = (synced: Synced, stamps: readonly Stamp[]): readonly Stamp[] => {
  const known = new Map(synced.stamps.map((stamp) => [stamp.id, stamp.stamp]))

  return stamps.filter((stamp) => known.get(stamp.id) !== stamp.stamp)
}

export const refreshed = (synced: Synced, stamps: readonly Stamp[], fresh: readonly PullRequest[]): readonly PullRequest[] =>
  stamps.flatMap((stamp) => {
    const pull = fresh.find((candidate) => candidate.id === stamp.id) ?? synced.pulls.find((candidate) => candidate.id === stamp.id)

    return pull === undefined ? [] : [pull]
  })

type Options = { readonly dryRun: boolean; readonly instructions: Text; readonly reviewInstructions: Text }

export class Watcher extends Context.Service<
  Watcher,
  {
    readonly cycle: (options: Options) => Effect.Effect<readonly Delivery[], unknown>
    readonly watch: (options: Options & { readonly interval: Duration.Duration; readonly probe: Duration.Duration }) => Effect.Effect<never>
  }
>()("prwatch/Watcher") {
  static readonly layer = Layer.effect(
    Watcher,
    Effect.gen(function* () {
      const github = yield* GitHub
      const host = yield* Host
      const workspace = yield* Workspace
      const store = yield* Store

      const placed = Effect.fn("Watcher.placed")(function* () {
        const agents = yield* host.agents.pipe(
          Effect.tapError((error) => Effect.logWarning(error.message)),
          Effect.orElseSucceed(() => [])
        )
        const located = yield* Effect.forEach(
          agents,
          (agent) =>
            Effect.map(
              workspace.locate(agent.cwd),
              Option.map((where) => ({ ...agent, ...where }))
            ),
          {
            concurrency: 8
          }
        )

        return { agents, placed: located.flatMap(Option.toArray) }
      })

      const send = Effect.fn("Watcher.send")(function* (delivery: Delivery, options: Options) {
        const message = agentMessage(
          delivery.pull,
          delivery.changes,
          delivery.pull.role === "reviewer" ? options.reviewInstructions : options.instructions
        )
        const { title, body } = notification(delivery.pull, delivery.changes)
        const alert = delivery.needsYou || delivery.agents.length === 0

        if (options.dryRun)
          return yield* Effect.log(
            `[dry run] to ${delivery.agents.map((agent) => agent.label).join(", ") || "nobody"}${alert ? " + notify" : ""}\n${message}`
          )

        yield* Effect.forEach(
          delivery.agents,
          (agent) =>
            host.deliver(agent.id, message).pipe(
              Effect.tapError((error) => Effect.logWarning(error.message)),
              Effect.ignore
            ),
          {
            discard: true
          }
        )
        if (alert) yield* host.notify(title, body)
      })

      const dispatch = Effect.fn("Watcher.dispatch")(function* (pulls: readonly PullRequest[], options: Options) {
        const [seen, previous, found, claims] = yield* Effect.all([store.seen, store.status, placed(), store.claims], { concurrency: 4 })
        const deliveries = plan(pulls, seen, found, claims)
        const at = isoTime(yield* DateTime.now)

        yield* Effect.forEach(deliveries, (delivery) => send(delivery, options), { discard: true })
        if (options.dryRun) return deliveries

        yield* store.saveSeen(nextSeen(pulls, seen))
        if (found.agents.length > 0) yield* store.saveClaims(liveClaims(claims, pulls, found.agents))
        yield* store.saveStatus(nextStatus(previous, pulls, deliveries, host.name, at))

        return deliveries
      })

      const cycle = Effect.fn("Watcher.cycle")(function* (options: Options) {
        const { pulls } = yield* github.pullRequests

        return yield* dispatch(pulls, options)
      })

      const tick = Effect.fn("Watcher.tick")(function* (state: Ref.Ref<Synced | undefined>, options: Options, interval: Duration.Duration) {
        const synced = yield* Ref.get(state)
        const now = yield* DateTime.now
        const stamps = yield* github.stamps

        if (synced === undefined || Duration.isGreaterThanOrEqualTo(DateTime.distance(synced.at, now), interval)) {
          const { pulls } = yield* github.pullRequests
          yield* dispatch(pulls, options)
          return yield* Ref.set(state, { at: now, stamps, pulls })
        }

        const moved = movedSince(synced, stamps)
        if (moved.length === 0 && stamps.length === synced.stamps.length) return

        const pulls = refreshed(synced, stamps, yield* github.pullsById(moved))
        yield* dispatch(pulls, options)
        yield* Ref.set(state, { at: synced.at, stamps, pulls })
      })

      const recordFailure = (error: unknown) =>
        Effect.gen(function* () {
          const message = Text.make(
            Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? error.message : String(error)
          )
          const previous = yield* store.status
          const at = isoTime(yield* DateTime.now)

          yield* Effect.logWarning(message)
          yield* store.saveStatus({ updatedAt: at, host: host.name, error: message, pulls: previous?.pulls ?? [] }).pipe(Effect.ignore)
        })

      const watch = (options: Options & { readonly interval: Duration.Duration; readonly probe: Duration.Duration }) =>
        Effect.flatMap(Ref.make<Synced | undefined>(undefined), (state) =>
          tick(state, options, options.interval).pipe(
            Effect.catch(recordFailure),
            Effect.repeat(Schedule.spaced(options.probe)),
            Effect.andThen(Effect.never)
          )
        )

      return Watcher.of({ cycle, watch })
    })
  )
}
