import { Context, Effect, Layer, Option, Schema } from "effect"

import { FieldPath, type Glob, IsoTime, Login, PrNumber, RepoSlug, Sha, type SourceKind, Text } from "./Brands.ts"
import { Raw, distinct, firstBy, globToRegExp, textAt } from "./Fields.ts"
import type { PullFact } from "./Linking.ts"
import { type Occurrence, occurrenceOf } from "./Occurrence.ts"
import type { Pending } from "./RunState.ts"
import { type CommandFailed, Shell } from "./Shell.ts"

export class ActivityUnavailable extends Schema.TaggedError<ActivityUnavailable>()("ActivityUnavailable", { reason: Text }) {
  override get message() {
    return `could not read workflow activity from GitHub (${this.reason})`
  }
}

const Id = Schema.Struct({ id: Schema.Unknown })
const Created = Schema.Struct({ created_at: IsoTime })
const Person = Schema.Struct({ login: Login })

const WorkflowRuns = Schema.Struct({ workflow_runs: Schema.Array(Raw) })
const CheckRuns = Schema.Struct({ check_runs: Schema.Array(Raw) })
const Commits = Schema.Array(Schema.Struct({ sha: Sha }))
const OpenPulls = Schema.Array(Schema.Struct({ user: Person, head: Schema.Struct({ sha: Sha }) }))
const Repos = Schema.Array(Schema.Struct({ nameWithOwner: RepoSlug, isArchived: Schema.Boolean }))

const PullItem = Schema.Struct({
  number: PrNumber,
  state: Text,
  merged_at: Schema.NullOr(IsoTime),
  merge_commit_sha: Schema.NullOr(Sha),
  head: Schema.Struct({ sha: Sha }),
  user: Person
})

const Status = Schema.Struct({
  state: Text,
  created_at: IsoTime,
  log_url: Schema.optionalKey(Schema.NullOr(Text)),
  target_url: Schema.optionalKey(Schema.NullOr(Text))
})

const CREATED_AT = FieldPath.make("created_at")
const STARTED_AT = FieldPath.make("started_at")
const COMPLETED_AT = FieldPath.make("completed_at")
const UPDATED_AT = FieldPath.make("updated_at")
const PUBLISHED_AT = FieldPath.make("published_at")
const CONTEXT = FieldPath.make("context")

const PAGES = [Text.make("--paginate"), Text.make("--slurp")]
const CANDIDATE_COMMITS = 10
const CONCURRENCY = 4

const timeAt = (raw: Raw, ...paths: readonly FieldPath[]) =>
  IsoTime.make(paths.map((path) => textAt(raw, path)).find((value) => value !== "") ?? "")

const recent = (since: IsoTime) => (raw: Raw) => Schema.is(Created)(raw) && raw.created_at >= since

export class Activity extends Context.Service<
  Activity,
  {
    readonly viewer: Effect.Effect<Login, ActivityUnavailable>
    readonly repos: (globs: readonly Glob[]) => Effect.Effect<readonly RepoSlug[], ActivityUnavailable>
    readonly occurrencesSince: (
      repo: RepoSlug,
      sources: readonly SourceKind[],
      since: IsoTime,
      viewer: Login,
      actorOnly: boolean
    ) => Effect.Effect<readonly Occurrence[], ActivityUnavailable>
    readonly refresh: (pending: Pending) => Effect.Effect<Option.Option<Occurrence>, ActivityUnavailable>
    readonly pulls: (repo: RepoSlug, sha: Sha) => Effect.Effect<readonly PullFact[], ActivityUnavailable>
  }
>()("prwatch/Activity") {
  static readonly layer = Layer.effect(
    Activity,
    Effect.gen(function* () {
      const shell = yield* Shell

      const unavailable = (error: CommandFailed | Schema.SchemaError) => new ActivityUnavailable({ reason: Text.make(error.message) })

      const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
        path: Text,
        schema: S,
        params: readonly Text[] = [],
        paging: readonly Text[] = []
      ) =>
        shell.run("gh", ["api", "-X", "GET", path, ...params.flatMap((param) => ["-f", param]), ...paging]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
          Effect.map((value): S["Type"] => value),
          Effect.mapError(unavailable)
        )

      const viewer = shell.run("gh", ["api", "user", "--jq", ".login"]).pipe(
        Effect.flatMap((login) => Schema.decodeUnknownEffect(Login)(login.trim())),
        Effect.mapError(unavailable),
        Effect.withSpan("Activity.viewer")
      )

      const owned = Effect.fn("Activity.owned")(function* (owner: Text) {
        const listed = yield* shell
          .run("gh", ["repo", "list", owner, "--limit", "300", "--json", "nameWithOwner,isArchived"])
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Repos))), Effect.mapError(unavailable))

        return listed.filter((repo) => !repo.isArchived).map((repo) => repo.nameWithOwner)
      })

      const repos = Effect.fn("Activity.repos")(function* (globs: readonly Glob[]) {
        const literal = globs
          .filter((glob) => !/[*?]/.test(glob))
          .flatMap((glob) => Option.toArray(Schema.decodeUnknownOption(RepoSlug)(glob)))
        const owners = distinct(globs.filter((glob) => /[*?]/.test(glob)).map((glob) => Text.make(glob.split("/")[0] ?? "")))
        const listed = yield* Effect.forEach(owners, owned, { concurrency: CONCURRENCY })
        const wild = globs.filter((glob) => /[*?]/.test(glob)).map(globToRegExp)

        return distinct([...literal, ...listed.flat().filter((repo) => wild.some((pattern) => pattern.test(repo)))])
      })

      const latestStatus = (repo: RepoSlug, id: Text) =>
        get(Text.make(`repos/${repo}/deployments/${id}/statuses`), Schema.Array(Status), [Text.make("per_page=1")]).pipe(
          Effect.map((statuses) => statuses[0])
        )

      const withStatus = Effect.fn("Activity.withStatus")(function* (repo: RepoSlug, raw: Raw) {
        const found = Schema.decodeUnknownOption(Id)(raw)
        if (Option.isNone(found)) return raw
        const status = yield* latestStatus(repo, Text.make(String(found.value.id)))

        return {
          ...raw,
          state: status?.state ?? "pending",
          log_url: status?.log_url ?? status?.target_url ?? null,
          updated_at: status?.created_at ?? textAt(raw, CREATED_AT)
        }
      })

      const deployments = Effect.fn("Activity.deployments")(function* (repo: RepoSlug, since: IsoTime) {
        const listed = yield* get(Text.make(`repos/${repo}/deployments`), Schema.Array(Raw), [Text.make("per_page=30")])

        return yield* Effect.forEach(listed.filter(recent(since)), (raw) => withStatus(repo, raw), { concurrency: CONCURRENCY })
      })

      const candidates = Effect.fn("Activity.candidates")(function* (repo: RepoSlug, viewer: Login) {
        const [commits, pulls] = yield* Effect.all(
          [
            get(Text.make(`repos/${repo}/commits`), Commits, [Text.make(`per_page=${CANDIDATE_COMMITS}`)]),
            get(Text.make(`repos/${repo}/pulls`), OpenPulls, [Text.make("state=open"), Text.make("per_page=50")])
          ],
          { concurrency: 2 }
        )

        return distinct([
          ...commits.map((commit) => commit.sha),
          ...pulls.filter((pull) => pull.user.login === viewer).map((pull) => pull.head.sha)
        ])
      })

      const checkRuns = (repo: RepoSlug, sha: Sha, since: IsoTime) =>
        get(Text.make(`repos/${repo}/commits/${sha}/check-runs`), CheckRuns, [Text.make("per_page=100")]).pipe(
          Effect.map(({ check_runs }) => check_runs.filter((raw) => timeAt(raw, STARTED_AT, COMPLETED_AT) >= since))
        )

      const statuses = (repo: RepoSlug, sha: Sha, since: IsoTime) =>
        get(Text.make(`repos/${repo}/commits/${sha}/statuses`), Schema.Array(Raw), [Text.make("per_page=100")]).pipe(
          Effect.map((listed) => firstBy(listed, (raw) => textAt(raw, CONTEXT))),
          Effect.map((latest) => latest.filter((raw) => timeAt(raw, UPDATED_AT) >= since).map((raw) => ({ ...raw, sha })))
        )

      const bySha = Effect.fn("Activity.bySha")(function* (repo: RepoSlug, source: SourceKind, since: IsoTime, viewer: Login) {
        const shas = yield* candidates(repo, viewer)
        const fetched = yield* Effect.forEach(
          shas,
          (sha) => (source === "check_run" ? checkRuns(repo, sha, since) : statuses(repo, sha, since)),
          {
            concurrency: CONCURRENCY
          }
        )

        return fetched.flat()
      })

      const workflowRuns = (repo: RepoSlug, since: IsoTime, viewer: Login, actorOnly: boolean) =>
        get(
          Text.make(`repos/${repo}/actions/runs`),
          Schema.Array(WorkflowRuns),
          [Text.make("per_page=100"), Text.make(`created=>=${since}`), ...(actorOnly ? [Text.make(`actor=${viewer}`)] : [])],
          PAGES
        ).pipe(Effect.map((pages) => pages.flatMap((page) => page.workflow_runs)))

      const raws = (
        repo: RepoSlug,
        source: SourceKind,
        since: IsoTime,
        viewer: Login,
        actorOnly: boolean
      ): Effect.Effect<readonly Raw[], ActivityUnavailable> => {
        if (source === "workflow_run") return workflowRuns(repo, since, viewer, actorOnly)
        if (source === "deployment") return deployments(repo, since)
        if (source === "release") {
          return get(Text.make(`repos/${repo}/releases`), Schema.Array(Raw), [Text.make("per_page=20")]).pipe(
            Effect.map((listed) => listed.filter((raw) => timeAt(raw, PUBLISHED_AT) >= since))
          )
        }

        return bySha(repo, source, since, viewer)
      }

      const occurrencesSince = Effect.fn("Activity.occurrencesSince")(function* (
        repo: RepoSlug,
        sources: readonly SourceKind[],
        at: IsoTime,
        who: Login,
        actorOnly: boolean
      ) {
        const found = yield* Effect.forEach(
          distinct(sources),
          (source) =>
            Effect.map(raws(repo, source, at, who, actorOnly), (list) =>
              list.flatMap((raw) => Option.toArray(occurrenceOf(source)(repo, raw)))
            ),
          {
            concurrency: CONCURRENCY
          }
        )

        return found.flat()
      })

      const one = (pending: Pending): Effect.Effect<Raw, ActivityUnavailable> => {
        const { repo, source, ref } = pending
        if (source === "workflow_run") return get(Text.make(`repos/${repo}/actions/runs/${ref}`), Raw)
        if (source === "check_run") return get(Text.make(`repos/${repo}/check-runs/${ref}`), Raw)
        if (source === "release") return get(Text.make(`repos/${repo}/releases/${ref}`), Raw)
        if (source === "deployment")
          return get(Text.make(`repos/${repo}/deployments/${ref}`), Raw).pipe(Effect.flatMap((raw) => withStatus(repo, raw)))

        return get(Text.make(`repos/${repo}/commits/${ref}/statuses`), Schema.Array(Raw), [Text.make("per_page=100")]).pipe(
          Effect.map((listed) => ({ ...listed.find((raw) => textAt(raw, CONTEXT) === pending.context), sha: ref }))
        )
      }

      const refresh = Effect.fn("Activity.refresh")(function* (pending: Pending) {
        const raw = yield* one(pending)

        return occurrenceOf(pending.source)(pending.repo, raw)
      })

      const pulls = Effect.fn("Activity.pulls")(function* (repo: RepoSlug, sha: Sha) {
        const listed = yield* get(Text.make(`repos/${repo}/commits/${sha}/pulls`), Schema.Array(PullItem))

        return listed.map((pull): PullFact => ({
          number: pull.number,
          open: pull.state === "open",
          merged: pull.merged_at !== null,
          head: pull.head.sha,
          mergeCommit: Option.fromNullishOr(pull.merge_commit_sha),
          author: pull.user.login
        }))
      })

      return Activity.of({ viewer, repos, occurrencesSince, refresh, pulls })
    })
  )
}
