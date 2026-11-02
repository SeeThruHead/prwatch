import { Schema } from "effect"

import { type Branch, type ForgeHost, type RepoSlug, RunId, Sha, Text, Url } from "./Brands.ts"

export const Run = Schema.Struct({
  id: RunId,
  workflow: Text,
  title: Text,
  url: Url,
  head: Sha,
  event: Text,
  done: Schema.Boolean,
  outcome: Schema.Literals(["passed", "failed", "other"])
})
export type Run = typeof Run.Type

export const BranchKey = Schema.NonEmptyString.pipe(Schema.brand("BranchKey"))
export type BranchKey = typeof BranchKey.Type

export type Watched = {
  readonly key: BranchKey
  readonly host: ForgeHost
  readonly repo: RepoSlug
  readonly branch: Branch
  readonly runs: readonly Run[]
}

export type BranchChange =
  | { readonly kind: "failed"; readonly run: Run; readonly jobs: readonly Text[] }
  | { readonly kind: "fixed"; readonly run: Run }

export const SeenBranch = Schema.Struct({ done: Schema.Array(RunId), failing: Schema.Array(Text) })
export type SeenBranch = typeof SeenBranch.Type

export const SeenBranches = Schema.Record(BranchKey, SeenBranch)
export type SeenBranches = typeof SeenBranches.Type

export const branchKey = (host: ForgeHost, repo: RepoSlug, branch: Branch): BranchKey => BranchKey.make(`${host}/${repo}@${branch}`)

const settled = (runs: readonly Run[]) => runs.filter((run) => run.done).toSorted((left, right) => left.id - right.id)

const failingAfter = (failing: readonly Text[], run: Run): readonly Text[] => {
  const others = failing.filter((workflow) => workflow !== run.workflow)
  if (run.outcome === "failed") return [...others, run.workflow]
  if (run.outcome === "passed") return others

  return failing
}

export const baseline = (runs: readonly Run[]): SeenBranch => {
  const done = settled(runs)

  return {
    done: done.map((run) => run.id),
    failing: done.reduce<readonly Text[]>(failingAfter, [])
  }
}

export type Pending = { readonly kind: "failed" | "fixed"; readonly run: Run }

const changeOf = (failing: readonly Text[], run: Run): readonly Pending[] => {
  if (run.outcome === "failed") return [{ kind: "failed", run }]
  if (run.outcome === "passed" && failing.includes(run.workflow)) return [{ kind: "fixed", run }]

  return []
}

export const branchChanges = (
  runs: readonly Run[],
  seen: SeenBranch | undefined
): { readonly changes: readonly Pending[]; readonly next: SeenBranch } => {
  if (seen === undefined) return { changes: [], next: baseline(runs) }

  const known = new Set(seen.done)
  const done = settled(runs)
  const fresh = done.filter((run) => !known.has(run.id))
  const walked = fresh.reduce<{ readonly failing: readonly Text[]; readonly changes: readonly Pending[] }>(
    (state, run) => ({
      failing: failingAfter(state.failing, run),
      changes: [...state.changes, ...changeOf(state.failing, run)]
    }),
    { failing: seen.failing, changes: [] }
  )

  return {
    changes: walked.changes,
    next: { done: done.map((run) => run.id), failing: walked.failing }
  }
}
