import { Effect, Schema } from "effect"

import {
  CommandLine,
  ExtractedKind,
  FieldPath,
  Glob,
  LinkKind,
  NotifyTarget,
  RegexSource,
  RuleName,
  RunOutcome,
  SourceKind,
  Text
} from "./Brands.ts"

export const Condition = Schema.Union([
  Schema.Struct({ field: FieldPath, glob: Schema.Union([Glob, Schema.Array(Glob)]) }),
  Schema.Struct({ field: FieldPath, in: Schema.Array(Text) }),
  Schema.Struct({ field: FieldPath, regex: RegexSource }),
  Schema.Struct({ field: FieldPath, exists: Schema.Boolean })
])
export type Condition = typeof Condition.Type

export const Extraction = Schema.Struct({
  extract: Schema.Struct({ from: FieldPath, regex: RegexSource, as: ExtractedKind })
})
export type Extraction = typeof Extraction.Type

export const Link = Schema.Union([LinkKind, Extraction])
export type Link = typeof Link.Type

export const Notify = Schema.Struct({
  on: Schema.Array(RunOutcome).pipe(Schema.withDecodingDefault(Effect.succeed<readonly RunOutcome[]>(["failed", "succeeded"]))),
  to: Schema.Array(NotifyTarget).pipe(Schema.withDecodingDefault(Effect.succeed<readonly NotifyTarget[]>(["pane"])))
})
export type Notify = typeof Notify.Type

export const Rule = Schema.Struct({
  name: RuleName,
  source: Schema.optionalKey(SourceKind),
  repos: Schema.Array(Glob),
  events: Schema.optionalKey(Schema.Array(Glob)),
  workflows: Schema.optionalKey(Schema.Array(Glob)),
  branches: Schema.optionalKey(Schema.Array(Glob)),
  environments: Schema.optionalKey(Schema.Array(Glob)),
  where: Schema.optionalKey(Schema.Array(Condition)),
  link: Link,
  notify: Notify.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  command: Schema.optionalKey(CommandLine),
  machines: Schema.optionalKey(Schema.Array(Glob))
})
export type Rule = typeof Rule.Type

export const WatchRules = Schema.Struct({ rules: Schema.Array(Rule) })
export type WatchRules = typeof WatchRules.Type
