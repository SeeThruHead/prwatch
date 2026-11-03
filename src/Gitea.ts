import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

import { Run } from "./Branches.ts"
import { type Checks, type Item, PullRequest, mentions, relevant } from "./GitHub.ts"
import {
  Branch,
  Count,
  FilePath,
  type ForgeHost,
  IsoTime,
  Login,
  Markdown,
  PrNumber,
  RepoSlug,
  type ReviewState,
  RunId,
  Sha,
  Text,
  Url,
  forgeHost
} from "./Brands.ts"
import { Store } from "./Store.ts"

const GiteaId = Schema.Int.pipe(Schema.brand("GiteaId"))

const GiteaReviewState = Schema.Literals(["APPROVED", "REQUEST_CHANGES", "COMMENT", "PENDING", "REQUEST_REVIEW"])

const Position = Schema.Int.pipe(Schema.brand("Position"))

const CommitState = Schema.Literals(["pending", "success", "error", "failure", "warning", ""])

const User = Schema.NullOr(Schema.Struct({ login: Login }))

const SearchHit = Schema.Struct({
  number: PrNumber,
  repository: Schema.Struct({ full_name: RepoSlug })
})

const PullDetail = Schema.Struct({
  number: PrNumber,
  title: Text,
  html_url: Url,
  draft: Schema.optionalKey(Schema.Boolean),
  mergeable: Schema.Boolean,
  head: Schema.Struct({ ref: Branch, sha: Sha })
})

const Review = Schema.Struct({
  id: GiteaId,
  state: GiteaReviewState,
  body: Markdown,
  html_url: Url,
  submitted_at: Schema.NullOr(IsoTime),
  user: User,
  comments_count: Count
})

const ReviewComment = Schema.Struct({
  id: GiteaId,
  body: Markdown,
  html_url: Url,
  created_at: IsoTime,
  path: FilePath,
  position: Position,
  original_position: Position,
  user: User
})

const IssueComment = Schema.Struct({
  id: GiteaId,
  body: Markdown,
  html_url: Url,
  created_at: IsoTime,
  user: User
})

const CombinedStatus = Schema.Struct({ state: CommitState, total_count: Count })

const CommitRef = Schema.Struct({ sha: Sha })

const ActionRun = Schema.Struct({
  id: RunId,
  path: Text,
  display_title: Text,
  html_url: Url,
  head_sha: Sha,
  event: Text,
  status: Text,
  conclusion: Schema.optionalKey(Schema.NullOr(Text))
})

const ActionRuns = Schema.Struct({ workflow_runs: Schema.NullOr(Schema.Array(ActionRun)) })

const ActionJobs = Schema.Struct({
  jobs: Schema.NullOr(Schema.Array(Schema.Struct({ name: Text, conclusion: Schema.optionalKey(Schema.NullOr(Text)) })))
})

const outcomeOf = (conclusion: Text | null | undefined): Run["outcome"] => {
  if (conclusion === "success") return "passed"
  if (conclusion === "failure") return "failed"

  return "other"
}

export const runOf = (run: typeof ActionRun.Type): Run => ({
  id: run.id,
  workflow: Text.make(run.path.replace(/@.*$/, "")),
  title: run.display_title,
  url: run.html_url,
  head: run.head_sha,
  event: run.event,
  done: run.status === "completed",
  outcome: outcomeOf(run.conclusion)
})

export const failedJobNames = (jobs: typeof ActionJobs.Type): readonly Text[] =>
  (jobs.jobs ?? []).filter((job) => job.conclusion === "failure").map((job) => job.name)

export const Fetched = Schema.Struct({
  repo: RepoSlug,
  pull: PullDetail,
  reviews: Schema.Array(Review),
  reviewComments: Schema.Array(ReviewComment),
  comments: Schema.Array(IssueComment),
  status: CombinedStatus,
  commits: Schema.Array(CommitRef)
})
export type Fetched = typeof Fetched.Type

const REVIEW_STATES: Readonly<Partial<Record<typeof GiteaReviewState.Type, ReviewState>>> = {
  APPROVED: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED"
}

export const checksOf = (status: typeof CombinedStatus.Type): Checks => {
  if (status.total_count === 0) return "none"
  if (status.state === "success" || status.state === "warning") return "passed"
  if (status.state === "failure" || status.state === "error") return "failed"

  return "pending"
}

const latestVerdicts = (reviews: Fetched["reviews"]) =>
  Object.values(
    Object.fromEntries(
      reviews
        .filter((review) => review.state === "APPROVED" || review.state === "REQUEST_CHANGES")
        .map((review) => [review.user?.login ?? "ghost", review.state] as const)
    )
  )

export const decisionOf = (reviews: Fetched["reviews"]): ReviewState | null => {
  const verdicts = latestVerdicts(reviews)
  if (verdicts.includes("REQUEST_CHANGES")) return "CHANGES_REQUESTED"
  if (verdicts.includes("APPROVED")) return "APPROVED"

  return null
}

const authorOf = (user: typeof User.Type) => {
  const login = user?.login ?? Login.make("ghost")

  return { author: login, bot: login.endsWith("[bot]") || login === "gitea-actions" }
}

const threadKey = (comment: typeof ReviewComment.Type) => Text.make(`${comment.path}:${comment.original_position}`)

export const itemsOf = (fetched: Fetched, viewer: Login): readonly (typeof Item.Encoded)[] => {
  const yours = new Set(fetched.reviewComments.filter((comment) => comment.user?.login === viewer).map(threadKey))

  return [
    ...fetched.reviews.flatMap((review) => {
      const state = REVIEW_STATES[review.state]
      if (state === undefined) return []

      return [
        {
          id: `gitea-review-${review.id}`,
          kind: "review" as const,
          ...authorOf(review.user),
          body: review.body,
          url: review.html_url,
          at: review.submitted_at ?? "",
          state,
          involvesYou: mentions(review.body, viewer)
        }
      ]
    }),
    ...fetched.comments.map((comment) => ({
      id: `gitea-comment-${comment.id}`,
      kind: "comment" as const,
      ...authorOf(comment.user),
      body: comment.body,
      url: comment.html_url,
      at: comment.created_at,
      involvesYou: mentions(comment.body, viewer)
    })),
    ...fetched.reviewComments.map((comment) => ({
      id: `gitea-thread-${comment.id}`,
      kind: "thread" as const,
      ...authorOf(comment.user),
      body: comment.body,
      url: comment.html_url,
      at: comment.created_at,
      path: comment.path,
      ...(comment.position > 0 ? { line: comment.position } : {}),
      involvesYou: yours.has(threadKey(comment)) || mentions(comment.body, viewer)
    }))
  ]
}

export const toPullRequest =
  (host: ForgeHost, viewer: Login, role: "author" | "reviewer") =>
  (fetched: Fetched): PullRequest => {
    const pull = Schema.decodeUnknownSync(PullRequest)({
      id: `gitea:${host}/${fetched.repo}#${fetched.pull.number}`,
      key: `${fetched.repo}#${fetched.pull.number}`,
      host,
      repo: fetched.repo,
      number: fetched.pull.number,
      title: fetched.pull.title,
      url: fetched.pull.html_url,
      branch: fetched.pull.head.ref,
      draft: fetched.pull.draft ?? false,
      head: fetched.pull.head.sha,
      checks: checksOf(fetched.status),
      decision: decisionOf(fetched.reviews),
      mergeable: fetched.pull.mergeable ? "yes" : "no",
      role,
      commits: fetched.commits.map((commit) => commit.sha),
      items: itemsOf(fetched, viewer),
      queued: false,
      merged: false,
      events: []
    })

    return { ...pull, items: pull.items.filter(relevant(role, viewer)) }
  }

export const GiteaConfig = Schema.Struct({ url: Url, token: Schema.String.pipe(Schema.brand("GiteaToken")) })

export class GiteaUnavailable extends Schema.TaggedError<GiteaUnavailable, { readonly brand: unique symbol }>()("GiteaUnavailable", {
  reason: Text
}) {
  override get message() {
    return `could not read your pull requests from Gitea (${this.reason}). Check gitea.json in your prwatch home: {"url": "https://gitea.example", "token": "<token with read access>"}`
  }
}

type Hit = typeof SearchHit.Type

const hitKey = (hit: Hit) => Text.make(`${hit.repository.full_name}#${hit.number}`)

const uniqueHits = (hits: readonly Hit[], exclude: ReadonlySet<Text>) =>
  hits.filter((hit, index) => !exclude.has(hitKey(hit)) && hits.findIndex((other) => hitKey(other) === hitKey(hit)) === index)

export class Gitea extends Context.Service<
  Gitea,
  {
    readonly pullRequests: Effect.Effect<{ readonly viewer: Login; readonly pulls: readonly PullRequest[] }, GiteaUnavailable>
    readonly host: Effect.Effect<Option.Option<ForgeHost>, GiteaUnavailable>
    readonly runs: (repo: RepoSlug, branch: Branch) => Effect.Effect<readonly Run[], GiteaUnavailable>
    readonly failedJobs: (repo: RepoSlug, run: RunId) => Effect.Effect<readonly Text[], GiteaUnavailable>
  }
>()("prwatch/Gitea") {
  static readonly layer = Layer.effect(
    Gitea,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const store = yield* Store
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const configFile = path.join(store.home, "gitea.json")

      const unavailable = (error: Error) => new GiteaUnavailable({ reason: Text.make(error.message) })

      const config = Effect.gen(function* () {
        if (!(yield* fs.exists(configFile))) return Option.none()

        const text = yield* fs.readFileString(configFile)
        const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(GiteaConfig))(text)

        return Option.some({ base: Url.make(parsed.url.replace(/\/+$/, "")), token: Redacted.make(parsed.token) })
      }).pipe(Effect.mapError(unavailable))

      const getFrom =
        (base: Url, token: Redacted.Redacted<typeof GiteaConfig.Type.token>) =>
        <S extends Schema.Top & { readonly DecodingServices: never }>(
          route: Text,
          schema: S,
          urlParams: ReadonlyArray<readonly [Text, Text]> = []
        ) =>
          http
            .get(`${base}/api/v1${route}`, { urlParams, headers: { authorization: `token ${Redacted.value(token)}` } })
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)), Effect.timeout("20 seconds"), Effect.mapError(unavailable))

      const repoPath = (repo: RepoSlug) => Text.make(`/repos/${repo.split("/").map(encodeURIComponent).join("/")}`)

      const configured = Effect.flatMap(
        config,
        Option.match({
          onNone: () => Effect.fail(new GiteaUnavailable({ reason: Text.make("gitea.json is missing") })),
          onSome: (found) => Effect.succeed({ ...found, get: getFrom(found.base, found.token) })
        })
      )

      const fetchFrom = (base: Url, token: Redacted.Redacted<typeof GiteaConfig.Type.token>) => {
        const get = getFrom(base, token)

        const search = (filter: Text) =>
          get(Text.make("/repos/issues/search"), Schema.Array(SearchHit), [
            [Text.make("type"), Text.make("pulls")],
            [Text.make("state"), Text.make("open")],
            [Text.make("limit"), Text.make("50")],
            [filter, Text.make("true")]
          ])

        const fetchPull = Effect.fn("Gitea.fetchPull")(function* (hit: Hit) {
          const repo = hit.repository.full_name
          const [owner, name] = repo.split("/").map(encodeURIComponent)
          const at = `/repos/${owner}/${name}`
          const [pull, reviews, comments, commits] = yield* Effect.all(
            [
              get(Text.make(`${at}/pulls/${hit.number}`), PullDetail),
              get(Text.make(`${at}/pulls/${hit.number}/reviews`), Schema.Array(Review)),
              get(Text.make(`${at}/issues/${hit.number}/comments`), Schema.Array(IssueComment)),
              get(Text.make(`${at}/pulls/${hit.number}/commits`), Schema.Array(CommitRef), [
                [Text.make("limit"), Text.make("100")],
                [Text.make("stat"), Text.make("false")],
                [Text.make("files"), Text.make("false")],
                [Text.make("verification"), Text.make("false")]
              ])
            ],
            { concurrency: 4 }
          )
          const [status, reviewComments] = yield* Effect.all(
            [
              get(Text.make(`${at}/commits/${pull.head.sha}/status`), CombinedStatus),
              Effect.forEach(
                reviews.filter((review) => review.comments_count > 0),
                (review) => get(Text.make(`${at}/pulls/${hit.number}/reviews/${review.id}/comments`), Schema.Array(ReviewComment)),
                { concurrency: 4 }
              )
            ],
            { concurrency: 2 }
          )

          return { repo, pull, reviews, reviewComments: reviewComments.flat(), comments, status, commits } satisfies Fetched
        })

        return Effect.gen(function* () {
          const viewer = (yield* get(Text.make("/user"), Schema.Struct({ login: Login }))).login
          const [authored, requested, reviewed, mentioned] = yield* Effect.all(
            [
              search(Text.make("created")),
              search(Text.make("review_requested")),
              search(Text.make("reviewed")),
              search(Text.make("mentioned"))
            ],
            { concurrency: 4 }
          )
          const mine = new Set(authored.map(hitKey))
          const others = uniqueHits([...requested, ...reviewed, ...mentioned], mine)
          const host = forgeHost(Text.make(new URL(base).host))
          const [own, reviewing] = yield* Effect.all(
            [Effect.forEach(authored, fetchPull, { concurrency: 4 }), Effect.forEach(others, fetchPull, { concurrency: 4 })],
            { concurrency: 2 }
          )

          return {
            viewer,
            pulls: [...own.map(toPullRequest(host, viewer, "author")), ...reviewing.map(toPullRequest(host, viewer, "reviewer"))]
          }
        })
      }

      const pullRequests = config.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed({ viewer: Login.make(""), pulls: [] }),
            onSome: ({ base, token }) => fetchFrom(base, token)
          })
        ),
        Effect.withSpan("Gitea.pullRequests")
      )

      const host = Effect.map(
        config,
        Option.map(({ base }) => forgeHost(Text.make(new URL(base).host)))
      )

      const runs = Effect.fn("Gitea.runs")(function* (repo: RepoSlug, branch: Branch) {
        const { get } = yield* configured
        const read = yield* get(Text.make(`${repoPath(repo)}/actions/runs`), ActionRuns, [
          [Text.make("branch"), Text.make(branch)],
          [Text.make("limit"), Text.make("20")]
        ])

        return (read.workflow_runs ?? []).map(runOf)
      })

      const failedJobs = Effect.fn("Gitea.failedJobs")(function* (repo: RepoSlug, run: RunId) {
        const { get } = yield* configured

        return yield* get(Text.make(`${repoPath(repo)}/actions/runs/${run}/jobs`), ActionJobs).pipe(Effect.map(failedJobNames))
      })

      return Gitea.of({ pullRequests, host, runs, failedJobs })
    })
  )
}
