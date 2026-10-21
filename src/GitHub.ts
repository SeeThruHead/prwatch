import { Context, Effect, Layer, Option, Schema } from "effect"

import { Branch, PrKey, RepoSlug, prKey } from "./Ids.ts"
import { type CommandFailed, Shell } from "./Shell.ts"

export const ItemKind = Schema.Literals(["review", "comment", "thread"])

export const Item = Schema.Struct({
  id: Schema.String,
  kind: ItemKind,
  author: Schema.String,
  bot: Schema.Boolean,
  body: Schema.String,
  url: Schema.String,
  at: Schema.String,
  state: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  involvesYou: Schema.Boolean
})
export type Item = typeof Item.Type

export const Checks = Schema.Literals(["pending", "passed", "failed", "none"])
export type Checks = typeof Checks.Type

export const PullRequest = Schema.Struct({
  key: PrKey,
  repo: RepoSlug,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  branch: Branch,
  draft: Schema.Boolean,
  head: Schema.String,
  checks: Checks,
  decision: Schema.NullOr(Schema.String),
  mergeable: Schema.Literals(["yes", "no", "unknown"]),
  role: Schema.Literals(["author", "reviewer"]),
  commits: Schema.Array(Schema.String),
  items: Schema.Array(Item)
})
export type PullRequest = typeof PullRequest.Type

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String, __typename: Schema.String }))

const Nodes = <S extends Schema.Top>(item: S) => Schema.Struct({ nodes: Schema.Array(item) })

const CommentNode = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  author: Author,
  body: Schema.String,
  url: Schema.String
})

const PullNode = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  headRefName: Schema.String,
  isDraft: Schema.Boolean,
  mergeable: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
  reviews: Nodes(
    Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      submittedAt: Schema.NullOr(Schema.String),
      author: Author,
      body: Schema.String,
      url: Schema.String
    })
  ),
  comments: Nodes(CommentNode),
  reviewThreads: Nodes(
    Schema.Struct({
      path: Schema.String,
      line: Schema.NullOr(Schema.Number),
      comments: Nodes(CommentNode)
    })
  ),
  latest: Nodes(
    Schema.Struct({
      commit: Schema.Struct({
        oid: Schema.String,
        statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String }))
      })
    })
  ),
  history: Nodes(Schema.Struct({ commit: Schema.Struct({ oid: Schema.String }) }))
})

const Response = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      login: Schema.String,
      pullRequests: Nodes(PullNode)
    }),
    commented: Nodes(Schema.Unknown),
    reviewed: Nodes(Schema.Unknown)
  })
})

const FIELDS = `
  number title url headRefName isDraft mergeable reviewDecision
  repository { nameWithOwner }
  reviews(last: 30) { nodes { id state submittedAt body url author { login __typename } } }
  comments(last: 30) { nodes { id createdAt body url author { login __typename } } }
  reviewThreads(last: 50) {
    nodes { path line comments(last: 20) { nodes { id createdAt body url author { login __typename } } } }
  }
  latest: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  history: commits(last: 100) { nodes { commit { oid } } }
`

const reviewing = (alias: string, qualifier: string) =>
  `${alias}: search(query: "is:pr is:open -author:@me ${qualifier}", type: ISSUE, first: 30) { nodes { ... on PullRequest { ${FIELDS} } } }`

const QUERY = `query {
  viewer {
    login
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${FIELDS} } }
  }
  ${reviewing("commented", "commenter:@me")}
  ${reviewing("reviewed", "reviewed-by:@me")}
}`

const checksOf = (state: string | undefined): Checks => {
  if (state === undefined) return "none"
  if (state === "SUCCESS") return "passed"
  if (state === "FAILURE" || state === "ERROR") return "failed"

  return "pending"
}

const mergeableOf = (state: string) => {
  if (state === "MERGEABLE") return "yes" as const
  if (state === "CONFLICTING") return "no" as const

  return "unknown" as const
}

const authorOf = (author: typeof Author.Type) => ({
  author: author?.login ?? "ghost",
  bot: author?.__typename === "Bot" || (author?.login ?? "").endsWith("[bot]")
})

type Pull = typeof PullNode.Type

const mentions = (body: string, viewer: string) => body.toLowerCase().includes(`@${viewer.toLowerCase()}`)

const itemsOf = (pull: Pull, viewer: string): readonly Item[] => [
  ...pull.reviews.nodes.flatMap((review) =>
    review.state === "PENDING"
      ? []
      : [
          {
            id: review.id,
            kind: "review" as const,
            ...authorOf(review.author),
            body: review.body,
            url: review.url,
            at: review.submittedAt ?? "",
            state: review.state,
            involvesYou: mentions(review.body, viewer)
          }
        ]
  ),
  ...pull.comments.nodes.map((comment) => ({
    id: comment.id,
    kind: "comment" as const,
    ...authorOf(comment.author),
    body: comment.body,
    url: comment.url,
    at: comment.createdAt,
    involvesYou: mentions(comment.body, viewer)
  })),
  ...pull.reviewThreads.nodes.flatMap((thread) => {
    const yours = thread.comments.nodes.some((comment) => comment.author?.login === viewer)

    return thread.comments.nodes.map((comment) => ({
      id: comment.id,
      kind: "thread" as const,
      ...authorOf(comment.author),
      body: comment.body,
      url: comment.url,
      at: comment.createdAt,
      path: thread.path,
      ...(thread.line === null ? {} : { line: thread.line }),
      involvesYou: yours || mentions(comment.body, viewer)
    }))
  })
]

const relevant = (role: "author" | "reviewer", viewer: string) => (item: Item) => {
  if (item.author === viewer) return false
  if (role === "author") return true

  return item.involvesYou
}

const toPullRequest =
  (viewer: string, role: "author" | "reviewer") =>
  (pull: Pull): PullRequest => {
    const repo = Schema.decodeSync(RepoSlug)(pull.repository.nameWithOwner)
    const commit = pull.latest.nodes[0]?.commit

    return {
      key: prKey(repo, pull.number),
      repo,
      number: pull.number,
      title: pull.title,
      url: pull.url,
      branch: Schema.decodeSync(Branch)(pull.headRefName),
      draft: pull.isDraft,
      head: commit?.oid ?? "",
      checks: checksOf(commit?.statusCheckRollup?.state),
      decision: pull.reviewDecision,
      mergeable: mergeableOf(pull.mergeable),
      role,
      commits: pull.history.nodes.map((node) => node.commit.oid),
      items: itemsOf(pull, viewer).filter(relevant(role, viewer))
    }
  }

export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()("GitHubUnavailable", {
  reason: Schema.String
}) {
  override get message() {
    return `could not read your pull requests from GitHub (${this.reason}). Is the gh CLI installed and logged in? Try: gh auth status`
  }
}

export class GitHub extends Context.Service<
  GitHub,
  { readonly pullRequests: Effect.Effect<{ readonly viewer: string; readonly pulls: readonly PullRequest[] }, GitHubUnavailable> }
>()("prwatch/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const shell = yield* Shell

      const unavailable = (error: CommandFailed | Schema.SchemaError) => new GitHubUnavailable({ reason: error.message })

      const pullRequests = shell.run("gh", ["api", "graphql", "-f", `query=${QUERY}`]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Response))),
        Effect.map(({ data }) => {
          const viewer = data.viewer.login
          const authored = data.viewer.pullRequests.nodes.map(toPullRequest(viewer, "author"))
          const others = [...data.commented.nodes, ...data.reviewed.nodes]
            .flatMap((node) => Option.toArray(Schema.decodeUnknownOption(PullNode)(node)))
            .map(toPullRequest(viewer, "reviewer"))
          const unique = others.filter((pull, index) => others.findIndex((other) => other.key === pull.key) === index)

          return { viewer, pulls: [...authored, ...unique] }
        }),
        Effect.mapError(unavailable),
        Effect.withSpan("GitHub.pullRequests")
      )

      return GitHub.of({ pullRequests })
    })
  )
}
