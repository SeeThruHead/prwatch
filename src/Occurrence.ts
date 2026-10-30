import { Option, Schema } from "effect"

import { Branch, IsoTime, Login, RepoSlug, RunId, RunKey, type RunOutcome, Sha, type SourceKind, Text, Url } from "./Brands.ts"
import { Raw } from "./Fields.ts"
import type { Pending } from "./RunState.ts"

export type Occurrence = {
  readonly key: RunKey
  readonly source: SourceKind
  readonly repo: RepoSlug
  readonly title: Text
  readonly url: Url
  readonly sha: Sha
  readonly branch: Option.Option<Branch>
  readonly actor: Option.Option<Login>
  readonly outcome: RunOutcome
  readonly at: IsoTime
  readonly pending: Pending
  readonly raw: Raw
}

export const isFinished = (occurrence: Occurrence) => occurrence.outcome !== "started"

const FAILED = ["failure", "timed_out", "startup_failure", "action_required", "error"].map((name) => Text.make(name))
const STARTED = ["queued", "in_progress", "pending", "waiting", "requested"].map((name) => Text.make(name))

const named = (names: readonly Text[], value: Text | null) => names.some((name) => name === value)

const concluded = (status: Text | null, conclusion: Text | null): RunOutcome => {
  if (named(STARTED, status)) return "started"
  if (conclusion === "success") return "succeeded"
  if (conclusion === "cancelled") return "cancelled"
  if (named(FAILED, conclusion)) return "failed"

  return "completed"
}

const stated = (state: Text | null): RunOutcome => {
  if (named(STARTED, state)) return "started"
  if (state === "success") return "succeeded"
  if (named(FAILED, state)) return "failed"

  return "completed"
}

const Person = Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Login })))

const pendingOf = (source: SourceKind, repo: RepoSlug, ref: Text, context?: Text): Pending => ({
  key: RunKey.make(`${source}:${repo}:${ref}${context === undefined ? "" : `:${context}`}`),
  source,
  repo,
  ref,
  ...(context === undefined ? {} : { context })
})

const loginOf = (...people: readonly ({ readonly login: Login } | null | undefined)[]) =>
  Option.fromNullishOr(people.find((person) => person !== null && person !== undefined)?.login)

const WorkflowRunFields = Schema.Struct({
  id: RunId,
  name: Schema.NullOr(Text),
  display_title: Schema.optionalKey(Schema.NullOr(Text)),
  html_url: Url,
  head_sha: Sha,
  head_branch: Schema.NullOr(Branch),
  status: Schema.NullOr(Text),
  conclusion: Schema.NullOr(Text),
  updated_at: IsoTime,
  triggering_actor: Person,
  actor: Person
})

const workflowTitle = (name: Text | null, title: Text | null | undefined) => {
  if (name === null && !title) return Text.make("workflow run")
  if (!title || title === name) return name ?? Text.make("workflow run")
  if (name === null) return title

  return Text.make(`${name}: ${title}`)
}

export const workflowRun = (repo: RepoSlug, raw: Raw): Option.Option<Occurrence> =>
  Option.map(Schema.decodeUnknownOption(WorkflowRunFields)(raw), (run) => {
    const pending = pendingOf("workflow_run", repo, Text.make(String(run.id)))

    return {
      key: pending.key,
      source: "workflow_run",
      repo,
      title: workflowTitle(run.name, run.display_title),
      url: run.html_url,
      sha: run.head_sha,
      branch: Option.fromNullishOr(run.head_branch),
      actor: loginOf(run.triggering_actor, run.actor),
      outcome: concluded(run.status, run.conclusion),
      at: run.updated_at,
      pending,
      raw
    }
  })

const CheckRunFields = Schema.Struct({
  id: RunId,
  name: Text,
  html_url: Url,
  head_sha: Sha,
  status: Schema.NullOr(Text),
  conclusion: Schema.NullOr(Text),
  started_at: Schema.optionalKey(Schema.NullOr(IsoTime)),
  completed_at: Schema.optionalKey(Schema.NullOr(IsoTime)),
  check_suite: Schema.optionalKey(Schema.NullOr(Schema.Struct({ head_branch: Schema.NullOr(Branch) })))
})

export const checkRun = (repo: RepoSlug, raw: Raw): Option.Option<Occurrence> =>
  Option.map(Schema.decodeUnknownOption(CheckRunFields)(raw), (run) => {
    const pending = pendingOf("check_run", repo, Text.make(String(run.id)))

    return {
      key: pending.key,
      source: "check_run",
      repo,
      title: run.name,
      url: run.html_url,
      sha: run.head_sha,
      branch: Option.fromNullishOr(run.check_suite?.head_branch),
      actor: Option.none(),
      outcome: concluded(run.status, run.conclusion),
      at: run.completed_at ?? run.started_at ?? IsoTime.make(""),
      pending,
      raw
    }
  })

const StatusFields = Schema.Struct({
  id: RunId,
  sha: Sha,
  state: Text,
  context: Text,
  description: Schema.optionalKey(Schema.NullOr(Text)),
  target_url: Schema.optionalKey(Schema.NullOr(Url)),
  updated_at: IsoTime,
  creator: Person
})

export const commitStatus = (repo: RepoSlug, raw: Raw): Option.Option<Occurrence> =>
  Option.map(Schema.decodeUnknownOption(StatusFields)(raw), (status) => {
    const pending = pendingOf("commit_status", repo, Text.make(status.sha), status.context)

    return {
      key: pending.key,
      source: "commit_status",
      repo,
      title: status.description ?? status.context,
      url: status.target_url ?? Url.make(`https://github.com/${repo}/commit/${status.sha}`),
      sha: status.sha,
      branch: Option.none(),
      actor: loginOf(status.creator),
      outcome: stated(status.state),
      at: status.updated_at,
      pending,
      raw
    }
  })

const DeploymentFields = Schema.Struct({
  id: RunId,
  sha: Sha,
  ref: Text,
  environment: Text,
  description: Schema.optionalKey(Schema.NullOr(Text)),
  state: Text,
  log_url: Schema.optionalKey(Schema.NullOr(Url)),
  updated_at: IsoTime,
  creator: Person
})

export const deployment = (repo: RepoSlug, raw: Raw): Option.Option<Occurrence> =>
  Option.map(Schema.decodeUnknownOption(DeploymentFields)(raw), (found) => {
    const pending = pendingOf("deployment", repo, Text.make(String(found.id)))

    return {
      key: pending.key,
      source: "deployment",
      repo,
      title: Text.make(`${found.environment} deployment${found.description ? `: ${found.description}` : ""}`),
      url: found.log_url ?? Url.make(`https://github.com/${repo}/deployments`),
      sha: found.sha,
      branch: Schema.decodeUnknownOption(Branch)(found.ref),
      actor: loginOf(found.creator),
      outcome: stated(found.state),
      at: found.updated_at,
      pending,
      raw
    }
  })

const ReleaseFields = Schema.Struct({
  id: RunId,
  tag_name: Text,
  name: Schema.optionalKey(Schema.NullOr(Text)),
  html_url: Url,
  target_commitish: Text,
  draft: Schema.Boolean,
  published_at: Schema.NullOr(IsoTime),
  author: Person
})

export const release = (repo: RepoSlug, raw: Raw): Option.Option<Occurrence> =>
  Option.flatMap(Schema.decodeUnknownOption(ReleaseFields)(raw), (found) => {
    const pending = pendingOf("release", repo, Text.make(String(found.id)))
    if (found.draft || found.published_at === null) return Option.none()

    return Option.some<Occurrence>({
      key: pending.key,
      source: "release",
      repo,
      title: found.name ?? found.tag_name,
      url: found.html_url,
      sha: Sha.make(found.target_commitish),
      branch: Option.none(),
      actor: loginOf(found.author),
      outcome: "succeeded",
      at: found.published_at,
      pending,
      raw
    })
  })

export const occurrenceOf = (source: SourceKind) => {
  if (source === "workflow_run") return workflowRun
  if (source === "check_run") return checkRun
  if (source === "commit_status") return commitStatus
  if (source === "deployment") return deployment

  return release
}
