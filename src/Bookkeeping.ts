import { DateTime, Effect } from "effect"

import { Store } from "./Store.ts"

export const acknowledge = Effect.fn("Bookkeeping.acknowledge")(function* (key: string) {
  const store = yield* Store
  const status = yield* store.status
  if (status === undefined) return false
  if (!status.pulls.some((pull) => pull.key === key)) return false

  yield* store.saveStatus({ ...status, pulls: status.pulls.map((pull) => (pull.key === key ? { ...pull, needsYou: false } : pull)) })
  return true
})

export const claim = Effect.fn("Bookkeeping.claim")(function* (keys: readonly string[], agent: string) {
  const store = yield* Store
  const claims = yield* store.claims
  const at = DateTime.formatIso(yield* DateTime.now)
  const added = Object.fromEntries(
    keys.map((key) => [key, [...(claims[key] ?? []).filter((entry) => entry.agent !== agent), { agent, at }]] as const)
  )

  yield* store.saveClaims({ ...claims, ...added })
})

export const release = Effect.fn("Bookkeeping.release")(function* (keys: readonly string[], agent: string | undefined) {
  const store = yield* Store
  const claims = yield* store.claims
  const kept = Object.entries(claims)
    .map(
      ([key, entries]) =>
        [key, keys.includes(key) ? entries.filter((entry) => agent !== undefined && entry.agent !== agent) : entries] as const
    )
    .filter(([, entries]) => entries.length > 0)

  yield* store.saveClaims(Object.fromEntries(kept))
})
