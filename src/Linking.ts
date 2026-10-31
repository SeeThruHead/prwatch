import { Option, Predicate, Schema } from "effect"

import { Branch, type FieldPath, type Login, PrNumber, type PrKey, type RegexSource, Sha, prKey } from "./Brands.ts"
import { compile, textsOf, valuesAt } from "./Fields.ts"
import type { Occurrence } from "./Occurrence.ts"
import type { Link } from "./Rules.ts"

export type PullFact = {
  readonly number: PrNumber
  readonly open: boolean
  readonly merged: boolean
  readonly head: Sha
  readonly branch: Branch
  readonly mergeCommit: Option.Option<Sha>
  readonly author: Login
}

export type Linked = {
  readonly pr: Option.Option<PrKey>
  readonly branch: Option.Option<Branch>
  readonly sha: Sha
  readonly claimantsOnly: boolean
}

export type LinkContext = { readonly viewer: Login; readonly pulls: readonly PullFact[] }

export const needsPulls = (link: Link) => link === "pr-head-sha" || link === "merge-commit" || link === "claim"

const linked = (occurrence: Occurrence, pr: Option.Option<PrKey>, claimantsOnly = false): Linked => ({
  pr,
  branch: occurrence.branch,
  sha: occurrence.sha,
  claimantsOnly
})

const throughPull = (occurrence: Occurrence, pull: PullFact, claimantsOnly = false): Linked => ({
  ...linked(occurrence, Option.some(prKey(occurrence.repo, pull.number)), claimantsOnly),
  branch: Option.some(pull.branch)
})

const headOf = (occurrence: Occurrence, pull: PullFact) => pull.open && pull.head === occurrence.sha

const mergedAs = (occurrence: Occurrence, pull: PullFact) =>
  pull.merged && Option.exists(pull.mergeCommit, (commit) => commit === occurrence.sha)

const startedBy = (occurrence: Occurrence, context: LinkContext) => Option.exists(occurrence.actor, (actor) => actor === context.viewer)

const mine = (context: LinkContext) => (pull: PullFact) => pull.author === context.viewer

const captured = (occurrence: Occurrence, spec: { readonly from: FieldPath; readonly regex: RegexSource }) =>
  Option.flatMap(compile(spec.regex), (regex) =>
    Option.fromNullishOr(
      textsOf(valuesAt(occurrence.raw, spec.from))
        .map((text) => regex.exec(text))
        .find(Predicate.isNotNull)
    )
  ).pipe(Option.map((match) => match[1] ?? match[0]))

const extracted = (link: Extract<Link, object>, occurrence: Occurrence): Option.Option<Linked> =>
  Option.flatMap(captured(occurrence, link.extract), (text) => {
    if (link.extract.as === "sha") return Option.some({ ...linked(occurrence, Option.none()), sha: Sha.make(text) })
    if (link.extract.as === "branch")
      return Option.map(Schema.decodeUnknownOption(Branch)(text), (branch) => ({
        ...linked(occurrence, Option.none()),
        branch: Option.some(branch)
      }))

    return Option.map(Schema.decodeUnknownOption(PrNumber)(Number(text)), (number) =>
      linked(occurrence, Option.some(prKey(occurrence.repo, number)))
    )
  })

export const resolve = (link: Link, occurrence: Occurrence, context: LinkContext): Option.Option<Linked> => {
  if (Predicate.isObject(link)) return extracted(link, occurrence)
  if (link === "any") return Option.some(linked(occurrence, Option.none()))
  if (link === "actor") return startedBy(occurrence, context) ? Option.some(linked(occurrence, Option.none())) : Option.none()

  const own = context.pulls.filter(mine(context))
  if (link === "pr-head-sha")
    return Option.map(Option.fromNullishOr(own.find((pull) => headOf(occurrence, pull))), (pull) => throughPull(occurrence, pull))
  if (link === "merge-commit")
    return Option.map(Option.fromNullishOr(own.find((pull) => mergedAs(occurrence, pull))), (pull) => throughPull(occurrence, pull))

  const any = context.pulls.find((pull) => headOf(occurrence, pull) || mergedAs(occurrence, pull))

  return Option.map(Option.fromNullishOr(any), (pull) => throughPull(occurrence, pull, true))
}
