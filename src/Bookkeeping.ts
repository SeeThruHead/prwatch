import { DateTime, Effect } from "effect"

import { type AgentId, type PrKey, type Text, isoTime } from "./Brands.ts"
import { routedTo } from "./Desk.ts"
import { type Agent, Host } from "./Host.ts"
import { fromOutside, routeMessage } from "./Message.ts"
import { initial } from "./Runs.ts"
import type { Pending } from "./RunState.ts"
import { Store } from "./Store.ts"

export const acknowledge = Effect.fn("Bookkeeping.acknowledge")(function* (key: PrKey) {
  const store = yield* Store
  const status = yield* store.status
  if (status === undefined) return false
  if (!status.pulls.some((pull) => pull.key === key)) return false

  yield* store.saveStatus({ ...status, pulls: status.pulls.map((pull) => (pull.key === key ? { ...pull, needsYou: false } : pull)) })
  return true
})

export const claim = Effect.fn("Bookkeeping.claim")(function* (keys: readonly PrKey[], agent: AgentId) {
  const store = yield* Store
  const claims = yield* store.claims
  const at = isoTime(yield* DateTime.now)
  const added = Object.fromEntries(
    keys.map((key) => [key, [...(claims[key] ?? []).filter((entry) => entry.agent !== agent), { agent, at }]] as const)
  )

  yield* store.saveClaims({ ...claims, ...added })
})

export const release = Effect.fn("Bookkeeping.release")(function* (keys: readonly PrKey[], agent: AgentId | undefined) {
  const store = yield* Store
  const claims = yield* store.claims
  const kept = Object.entries(claims)
    .map(
      ([key, entries]) =>
        [
          key,
          keys.some((wanted) => wanted === key) ? entries.filter((entry) => agent !== undefined && entry.agent !== agent) : entries
        ] as const
    )
    .filter(([, entries]) => entries.length > 0)

  yield* store.saveClaims(Object.fromEntries(kept))
})

export const watchRun = Effect.fn("Bookkeeping.watchRun")(function* (pending: Pending, agent: AgentId) {
  const store = yield* Store
  const state = (yield* store.runs) ?? initial(yield* DateTime.now)
  const agents = [...(state.watches[pending.key]?.agents ?? []).filter((entry) => entry !== agent), agent]

  yield* store.saveRuns({ ...state, watches: { ...state.watches, [pending.key]: { pending, agents } } })
})

export type RouteOutcome = "routed" | "no desk" | "not watched" | "no agent"

const ROUTED: RouteOutcome = "routed"
const NO_DESK: RouteOutcome = "no desk"
const NOT_WATCHED: RouteOutcome = "not watched"
const NO_AGENT: RouteOutcome = "no agent"

export const route = Effect.fn("Bookkeeping.route")(function* (key: PrKey, target: AgentId, instructions: Text) {
  const store = yield* Store
  const host = yield* Host
  const desk = yield* store.desk
  if (desk === undefined) return NO_DESK

  const watched = (yield* store.status)?.pulls.find((entry) => entry.key === key)
  if (watched === undefined) return NOT_WATCHED

  const panes = yield* host.agents.pipe(Effect.orElseSucceed((): readonly Agent[] => []))
  if (!panes.some((pane) => pane.id === target)) return NO_AGENT

  yield* release([key], desk.agent)
  yield* claim([key], target)
  yield* store.saveDesk(routedTo(desk, key))
  yield* host.deliver(target, fromOutside(routeMessage(key, watched.url, instructions)))

  return ROUTED
})
