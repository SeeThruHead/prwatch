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
  id: Schema.String,
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

type Role = PullRequest["role"]

export type Stamp = { readonly id: string; readonly role: Role; readonly stamp: string }

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
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  headRefName: Schema.String,
  isDraft: Schema.Boolean,
  mergeable: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  repository: Schema.Struct({ nameWithOwner: Schema.String, isPrivate: Schema.Boolean }),
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

const StampNode = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.String,
  headRefOid: Schema.String,
  isDraft: Schema.Boolean,
  mergeable: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  repository: Schema.Struct({ isPrivate: Schema.Boolean }),
  latest: Nodes(Schema.Struct({ commit: Schema.Struct({ statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })) }) }))
})

const ResponseOf = <S extends Schema.Top>(node: S) =>
  Schema.Struct({
    data: Schema.Struct({
      viewer: Schema.Struct({
        login: Schema.String,
        pullRequests: Nodes(node)
      }),
      commented: Nodes(Schema.Unknown),
      reviewed: Nodes(Schema.Unknown)
    })
  })

const ByIdResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    nodes: Schema.Array(Schema.Unknown)
  })
})

const FIELDS = `
  id number title url headRefName isDraft mergeable reviewDecision
  repository { nameWithOwner isPrivate }
  reviews(last: 30) { nodes { id state submittedAt body url author { login __typename } } }
  comments(last: 30) { nodes { id createdAt body url author { login __typename } } }
  reviewThreads(last: 50) {
    nodes { path line comments(last: 20) { nodes { id createdAt body url author { login __typename } } } }
  }
  latest: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  history: commits(last: 100) { nodes { commit { oid } } }
`

const STAMP_FIELDS = `
  id updatedAt headRefOid isDraft mergeable reviewDecision
  repository { isPrivate }
  latest: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`

const reviewing = (alias: string, qualifier: string, fields: string) =>
  `${alias}: search(query: "is:pr is:open -author:@me ${qualifier}", type: ISSUE, first: 30) { nodes { ... on PullRequest { ${fields} } } }`

const queryOf = (fields: string) => `query {
  viewer {
    login
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${fields} } }
  }
  ${reviewing("commented", "commenter:@me", fields)}
  ${reviewing("reviewed", "reviewed-by:@me", fields)}
}`

const QUERY = queryOf(FIELDS)
const PROBE = queryOf(STAMP_FIELDS)
const BY_ID = `query($ids: [ID!]!) { viewer { login } nodes(ids: $ids) { ... on PullRequest { ${FIELDS} } } }`

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

const isPrivate = (pull: { readonly repository: { readonly isPrivate: boolean } }) => pull.repository.isPrivate

const withRoles = <A extends { readonly id: string; readonly repository: { readonly isPrivate: boolean } }>(
  authored: readonly A[],
  others: readonly unknown[],
  decode: (node: unknown) => Option.Option<A>
): readonly { readonly node: A; readonly role: Role }[] => {
  const reviewing = others.flatMap((node) => Option.toArray(decode(node)))
  const unique = reviewing.filter((node, index) => reviewing.findIndex((other) => other.id === node.id) === index)

  return [
    ...authored.map((node) => ({ node, role: "author" as const })),
    ...unique.map((node) => ({ node, role: "reviewer" as const }))
  ].filter(({ node }) => isPrivate(node))
}

const stampOf = ({ node, role }: { readonly node: typeof StampNode.Type; readonly role: Role }): Stamp => ({
  id: node.id,
  role,
  stamp: [
    node.updatedAt,
    node.headRefOid,
    node.isDraft,
    node.mergeable,
    node.reviewDecision,
    node.latest.nodes[0]?.commit.statusCheckRollup?.state
  ].join(" ")
})

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

const relevant = (role: Role, viewer: string) => (item: Item) => {
  if (item.author === viewer) return false
  if (role === "author") return true

  return item.involvesYou
}

const toPullRequest =
  (viewer: string, role: Role) =>
  (pull: Pull): PullRequest => {
    const repo = Schema.decodeSync(RepoSlug)(pull.repository.nameWithOwner)
    const commit = pull.latest.nodes[0]?.commit

    return {
      id: pull.id,
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
  {
    readonly pullRequests: Effect.Effect<{ readonly viewer: string; readonly pulls: readonly PullRequest[] }, GitHubUnavailable>
    readonly stamps: Effect.Effect<readonly Stamp[], GitHubUnavailable>
    readonly pullsById: (stamps: readonly Stamp[]) => Effect.Effect<readonly PullRequest[], GitHubUnavailable>
  }
>()("prwatch/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const shell = yield* Shell

      const unavailable = (error: CommandFailed | Schema.SchemaError) => new GitHubUnavailable({ reason: error.message })

      const graphql = (query: string, variables: readonly string[] = []) =>
        shell.run("gh", ["api", "graphql", "-f", `query=${query}`, ...variables.flatMap((variable) => ["-f", variable])])

      const pullRequests = graphql(QUERY).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ResponseOf(PullNode)))),
        Effect.map(({ data }) => {
          const viewer = data.viewer.login
          const pulls = withRoles(
            data.viewer.pullRequests.nodes,
            [...data.commented.nodes, ...data.reviewed.nodes],
            Schema.decodeUnknownOption(PullNode)
          ).map(({ node, role }) => toPullRequest(viewer, role)(node))

          return { viewer, pulls }
        }),
        Effect.mapError(unavailable),
        Effect.withSpan("GitHub.pullRequests")
      )

      const stamps = graphql(PROBE).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ResponseOf(StampNode)))),
        Effect.map(({ data }) =>
          withRoles(
            data.viewer.pullRequests.nodes,
            [...data.commented.nodes, ...data.reviewed.nodes],
            Schema.decodeUnknownOption(StampNode)
          ).map(stampOf)
        ),
        Effect.mapError(unavailable),
        Effect.withSpan("GitHub.stamps")
      )

      const pullsById = Effect.fn("GitHub.pullsById")(function* (wanted: readonly Stamp[]) {
        if (wanted.length === 0) return []

        const { data } = yield* graphql(
          BY_ID,
          wanted.map((stamp) => `ids[]=${stamp.id}`)
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ByIdResponse))), Effect.mapError(unavailable))

        return data.nodes
          .flatMap((node) => Option.toArray(Schema.decodeUnknownOption(PullNode)(node)))
          .filter(isPrivate)
          .flatMap((pull) =>
            wanted.filter((stamp) => stamp.id === pull.id).map((stamp) => toPullRequest(data.viewer.login, stamp.role)(pull))
          )
      })

      return GitHub.of({ pullRequests, stamps, pullsById })
    })
  )
}
