import { Array as Arr, Option, Predicate, Schema } from "effect"

import { type FieldPath, type Glob, type Hostname, type RegexSource, type RepoSlug, Text } from "./Brands.ts"

export const Raw = Schema.Record(Text, Schema.Unknown)
export type Raw = typeof Raw.Type

const step = (value: unknown, key: PropertyKey): readonly unknown[] => {
  if (Arr.isArray(value)) return value.flatMap((entry) => step(entry, key))
  if (!Predicate.hasProperty(value, key)) return []

  return [value[key]]
}

export const valuesAt = (raw: Raw, path: FieldPath): readonly unknown[] =>
  path.split(".").reduce<readonly unknown[]>((values, key) => values.flatMap((value) => step(value, key)), [raw])

const isScalar = Predicate.or(Predicate.isString, Predicate.or(Predicate.isNumber, Predicate.isBoolean))

export const textsOf = (values: readonly unknown[]): readonly Text[] => values.filter(isScalar).map((value) => Text.make(String(value)))

export const compile = Option.liftThrowable((source: RegexSource) => new RegExp(source))

const SPECIALS = /[.+^${}()|[\]\\]/g

export const globToRegExp = (glob: Glob) =>
  new RegExp(`^${glob.replace(SPECIALS, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "i")

export const globsMatch = (globs: readonly Glob[], text: Text | RepoSlug | Hostname) => globs.some((glob) => globToRegExp(glob).test(text))

export const distinct = <A>(items: readonly A[]): readonly A[] => [...new Set(items)]

export const firstBy = <A>(items: readonly A[], key: (item: A) => PropertyKey): readonly A[] =>
  Object.values(Object.fromEntries([...items].reverse().map((item) => [key(item), item]))).reverse()

export const lastBy = <A>(items: readonly A[], key: (item: A) => PropertyKey): readonly A[] =>
  Object.values(Object.fromEntries(items.map((item) => [key(item), item])))

export const textAt = (raw: Raw, path: FieldPath) => textsOf(valuesAt(raw, path))[0] ?? Text.make("")
