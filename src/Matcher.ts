import { Array as Arr, Option, Predicate } from "effect"

import { FieldPath, type Glob, type Hostname, Text } from "./Brands.ts"
import { compile, globsMatch, textsOf, valuesAt } from "./Fields.ts"
import type { Occurrence } from "./Occurrence.ts"
import type { Condition, Rule } from "./Rules.ts"

type Shortcut = "events" | "workflows" | "branches" | "environments"

const SHORTCUTS = {
  workflow_run: { events: FieldPath.make("event"), workflows: FieldPath.make("name"), branches: FieldPath.make("head_branch") },
  check_run: { workflows: FieldPath.make("name"), branches: FieldPath.make("check_suite.head_branch") },
  commit_status: { workflows: FieldPath.make("context") },
  deployment: { branches: FieldPath.make("ref"), environments: FieldPath.make("environment") },
  release: { branches: FieldPath.make("target_commitish") }
} as const

const SHORTCUT_NAMES: readonly Shortcut[] = ["events", "workflows", "branches", "environments"]

export const sourceOf = (rule: Rule) => rule.source ?? "workflow_run"

const shortcutField = (rule: Rule, name: Shortcut): Option.Option<FieldPath> => {
  const available: Readonly<Partial<Record<Shortcut, FieldPath>>> = SHORTCUTS[sourceOf(rule)]

  return Option.fromNullishOr(available[name])
}

const used = (rule: Rule) => SHORTCUT_NAMES.filter((name) => rule[name] !== undefined)

export const conditionsOf = (rule: Rule): readonly Condition[] => [
  ...used(rule).flatMap((name) =>
    Option.toArray(Option.map(shortcutField(rule, name), (path) => ({ field: path, glob: rule[name] ?? [] })))
  ),
  ...(rule.where ?? [])
]

const globsOf = (glob: Glob | readonly Glob[]): readonly Glob[] => (Predicate.isString(glob) ? [glob] : glob)

export const holds = (condition: Condition, occurrence: Occurrence): boolean => {
  const values = valuesAt(occurrence.raw, condition.field)
  const texts = textsOf(values)

  if ("exists" in condition) return values.some(Predicate.isNotNullish) === condition.exists
  if ("glob" in condition) return texts.some((text) => globsMatch(globsOf(condition.glob), text))
  if ("in" in condition) return texts.some((text) => condition.in.some((candidate) => candidate === text))

  return Option.match(compile(condition.regex), { onNone: () => false, onSome: (regex) => texts.some((text) => regex.test(text)) })
}

const onMachine = (rule: Rule, host: Hostname) => rule.machines === undefined || globsMatch(rule.machines, host)

export const ruleMatches = (rule: Rule, occurrence: Occurrence, host: Hostname) => {
  if (sourceOf(rule) !== occurrence.source) return false
  if (!onMachine(rule, host)) return false
  if (!globsMatch(rule.repos, occurrence.repo)) return false

  return conditionsOf(rule).every((condition) => holds(condition, occurrence))
}

const LITERAL_OWNER = /^[^*?/]+\/.+$/

const regexProblems = (rule: Rule): readonly Text[] => {
  const sources = [
    ...(rule.where ?? []).flatMap((condition) => ("regex" in condition ? [condition.regex] : [])),
    ...(Predicate.isObject(rule.link) ? [rule.link.extract.regex] : [])
  ]

  return sources
    .filter((source) => Option.isNone(compile(source)))
    .map((source) => Text.make(`${rule.name}: invalid regular expression ${source}`))
}

const shortcutProblems = (rule: Rule): readonly Text[] =>
  used(rule)
    .filter((name) => Option.isNone(shortcutField(rule, name)))
    .map((name) => Text.make(`${rule.name}: ${name} does not apply to ${sourceOf(rule)}; use where with a field instead`))

const repoProblems = (rule: Rule): readonly Text[] =>
  rule.repos
    .filter((repo) => !LITERAL_OWNER.test(repo))
    .map((repo) => Text.make(`${rule.name}: repos entry ${repo} needs a literal owner, like owner/*`))

export const problems = (rules: readonly Rule[]): readonly Text[] =>
  Arr.flatMap(rules, (rule) => [...regexProblems(rule), ...shortcutProblems(rule), ...repoProblems(rule)])
