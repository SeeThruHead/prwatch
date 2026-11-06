import { DateTime, Option, Schema } from "effect"

import { AgentId, IsoTime, type Login, NodeId, Text } from "./Brands.ts"
import type { Item, PullRequest } from "./GitHub.ts"

export const DeskState = Schema.Struct({ agent: AgentId, since: IsoTime, handled: Schema.Array(NodeId) })
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

export const reviewRequests = (pulls: readonly PullRequest[], from: readonly Login[], desk: DeskState): readonly ReviewRequest[] =>
  pulls
    .filter((pull) => pull.role === "reviewer")
    .flatMap((pull) => {
      const items = pull.items.filter(asksForReview(from, desk))

      return items.length === 0 ? [] : [{ pull, items }]
    })

export const handledAfter = (desk: DeskState, requests: readonly ReviewRequest[]): DeskState => ({
  ...desk,
  handled: [...desk.handled, ...requests.flatMap((request) => request.items.map((item) => item.id))].slice(-REMEMBERED)
})

export const requesters = (request: ReviewRequest) => Text.make([...new Set(request.items.map((item) => item.author))].join(", "))
