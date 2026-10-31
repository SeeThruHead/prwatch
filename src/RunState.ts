import { Schema } from "effect"

import { AgentId, IsoTime, RepoSlug, RuleName, RunKey, RunOutcome, SourceKind, Text, Url } from "./Brands.ts"

export const Pending = Schema.Struct({ key: RunKey, source: SourceKind, repo: RepoSlug, ref: Text, context: Schema.optionalKey(Text) })
export type Pending = typeof Pending.Type

export const Seen = Schema.Struct({ outcome: RunOutcome, at: IsoTime })

export const RunState = Schema.Struct({
  since: IsoTime,
  seen: Schema.Record(RunKey, Seen),
  pending: Schema.Record(RunKey, Pending),
  watches: Schema.Record(RunKey, Schema.Struct({ pending: Pending, agents: Schema.Array(AgentId) }))
})
export type RunState = typeof RunState.Type

export const StatusRun = Schema.Struct({
  key: RunKey,
  title: Text,
  url: Url,
  outcome: RunOutcome,
  rule: Schema.optionalKey(RuleName),
  at: IsoTime,
  needsYou: Schema.Boolean
})
export type StatusRun = typeof StatusRun.Type
