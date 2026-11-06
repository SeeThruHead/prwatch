import { DateTime, Option, Schema } from "effect"

import { AgentId, IsoTime, type Login, NodeId, PrKey, Text } from "./Brands.ts"
import { globsMatch } from "./Fields.ts"
import type { Item, PullRequest } from "./GitHub.ts"
import type { DeskConfig } from "./Rules.ts"

export const DeskState = Schema.Struct({
  agent: AgentId,
  since: IsoTime,
  handled: Schema.Array(NodeId),
  routed: Schema.optionalKey(Schema.Array(PrKey))
})
export type DeskState = typeof DeskState.Type

export type ReviewRequest = { readonly pull: PullRequest; readonly items: readonly Item[] }

const REMEMBERED = 500

const sameLogin = (left: Login, right: Login) => left.toLowerCase() === right.toLowerCase()

const atOrAfter = (at: IsoTime, since: IsoTime) =>
  Option.getOrElse(Option.zipWith(DateTime.make(at), DateTime.make(since), DateTime.isGreaterThanOrEqualTo), () => false)

const asksForReview = (from: readonly Login[], desk: DeskState) => (item: Item) => {
  if (!item.mentionsYou) return false
  if (item.bot) return false
  if (desk.handled.includes(item.id)) return false
  if (!atOrAfter(item.at, desk.since)) return false

  return from.some((login) => sameLogin(login, item.author))
}

const deskTakes = (config: DeskConfig) => (pull: PullRequest) => {
  if (pull.role !== "reviewer") return false

  return globsMatch(config.repos, pull.repo)
}

export const reviewRequests = (pulls: readonly PullRequest[], config: DeskConfig, desk: DeskState): readonly ReviewRequest[] =>
  pulls.filter(deskTakes(config)).flatMap((pull) => {
    const items = pull.items.filter(asksForReview(config.from, desk))

    return items.length === 0 ? [] : [{ pull, items }]
  })

export const handledAfter = (desk: DeskState, requests: readonly ReviewRequest[]): DeskState => ({
  ...desk,
  handled: [...desk.handled, ...requests.flatMap((request) => request.items.map((item) => item.id))].slice(-REMEMBERED)
})

export const routedTo = (desk: DeskState, key: PrKey): DeskState => ({
  ...desk,
  routed: [...(desk.routed ?? []).filter((entry) => entry !== key), key].slice(-REMEMBERED)
})

export const isRouted = (desk: DeskState | undefined, key: PrKey) => (desk?.routed ?? []).includes(key)

export const requesters = (request: ReviewRequest) => Text.make([...new Set(request.items.map((item) => item.author))].join(", "))
