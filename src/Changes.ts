import { Schema } from "effect"

import { type Checks, type Item, type PullRequest } from "./GitHub.ts"
import { PrKey } from "./Ids.ts"

export const SeenPull = Schema.Struct({
  items: Schema.Array(Schema.String),
  head: Schema.String,
  checks: Schema.String,
  decision: Schema.NullOr(Schema.String),
  ready: Schema.Boolean
})
export type SeenPull = typeof SeenPull.Type

export const Seen = Schema.Record(PrKey, SeenPull)
export type Seen = typeof Seen.Type

export type Change =
  | { readonly kind: "item"; readonly item: Item }
  | { readonly kind: "checks"; readonly checks: Extract<Checks, "passed" | "failed">; readonly head: string }
  | { readonly kind: "decision"; readonly decision: string }
  | { readonly kind: "ready" }
  | { readonly kind: "pushed"; readonly head: string }

const isSettled = (checks: Checks): checks is "passed" | "failed" => checks === "passed" || checks === "failed"

export const isReady = (pull: PullRequest, before: boolean) => {
  if (pull.draft) return false
  if (pull.checks === "failed" || pull.checks === "pending") return false
  if (pull.decision !== "APPROVED") return false
  if (pull.mergeable === "unknown") return before

  return pull.mergeable === "yes"
}

export const snapshotOf = (pull: PullRequest, seen: SeenPull | undefined): SeenPull => ({
  items: pull.items.map((item) => item.id),
  head: pull.head,
  checks: pull.checks,
  decision: pull.decision,
  ready: isReady(pull, seen?.ready ?? false)
})

const checksChanged = (pull: PullRequest, seen: SeenPull) => {
  if (!isSettled(pull.checks)) return false

  return pull.head !== seen.head || pull.checks !== seen.checks
}

const reviewerChanges = (pull: PullRequest, seen: SeenPull, items: readonly Change[]): readonly Change[] => {
  const pushed: readonly Change[] = pull.head !== "" && pull.head !== seen.head ? [{ kind: "pushed", head: pull.head }] : []

  return [...items, ...pushed]
}

export const changesSince = (pull: PullRequest, seen: SeenPull | undefined): readonly Change[] => {
  if (seen === undefined) return []

  const known = new Set(seen.items)
  const items = pull.items.filter((item) => !known.has(item.id)).map((item): Change => ({ kind: "item", item }))
  if (pull.role === "reviewer") return reviewerChanges(pull, seen, items)

  const checks: readonly Change[] =
    checksChanged(pull, seen) && isSettled(pull.checks) ? [{ kind: "checks", checks: pull.checks, head: pull.head }] : []
  const decision: readonly Change[] =
    pull.decision !== null && pull.decision !== seen.decision ? [{ kind: "decision", decision: pull.decision }] : []
  const ready: readonly Change[] = isReady(pull, seen.ready) && !seen.ready ? [{ kind: "ready" }] : []

  return [...items, ...checks, ...decision, ...ready]
}

export const needsYou = (change: Change) => {
  if (change.kind === "item") return !change.item.bot
  if (change.kind === "decision") return change.decision === "APPROVED" || change.decision === "CHANGES_REQUESTED"

  return change.kind === "ready"
}
