import { Option } from "effect"

import type { Hostname, RunOutcome } from "./Brands.ts"
import { type LinkContext, type Linked, needsPulls, resolve } from "./Linking.ts"
import { ruleMatches } from "./Matcher.ts"
import type { Occurrence } from "./Occurrence.ts"
import type { Rule } from "./Rules.ts"

export type Verdict = {
  readonly rule: Rule
  readonly matched: boolean
  readonly linked: Option.Option<Linked>
  readonly wanted: boolean
}

export const wanted = (rule: Rule, outcome: RunOutcome) => {
  if (rule.notify.on.includes(outcome)) return true

  return rule.notify.on.includes("completed") && outcome !== "started"
}

export const pullsNeeded = (rules: readonly Rule[], occurrence: Occurrence, host: Hostname) =>
  rules.some((rule) => ruleMatches(rule, occurrence, host) && needsPulls(rule.link))

export const evaluate = (rules: readonly Rule[], occurrence: Occurrence, host: Hostname, context: LinkContext): readonly Verdict[] =>
  rules.map((rule) => {
    const matched = ruleMatches(rule, occurrence, host)
    const linked = matched ? resolve(rule.link, occurrence, context) : Option.none()

    return { rule, matched, linked, wanted: wanted(rule, occurrence.outcome) }
  })

export const route = (verdicts: readonly Verdict[]) =>
  Option.flatMap(Option.fromNullishOr(verdicts.find((verdict) => verdict.matched && Option.isSome(verdict.linked))), (verdict) =>
    Option.map(verdict.linked, (linked) => ({ rule: verdict.rule, linked }))
  )
