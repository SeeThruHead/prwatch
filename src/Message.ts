import { type FilePath, type LineNumber, type Markdown, Text } from "./Brands.ts"
import type { Change } from "./Changes.ts"
import type { PullRequest } from "./GitHub.ts"

const EXCERPT = 240

export const REVIEW_INSTRUCTIONS = Text.make(
  "You are reviewing this pull request for the user. Read each thread and any new commits, then draft the user's next reply or an updated review, and show it to the user before posting anything."
)

export const DEFAULT_INSTRUCTIONS = Text.make(
  "Read each thread in full with gh before acting. Fix what bots raise yourself. For comments from people, draft your reply and any change, and show them to the user before posting anything."
)

const visibleText = (body: Markdown) =>
  body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<details>[\s\S]*?<\/details>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " [code] ")

const KIND_LABELS = { review: "review", thread: "review comment", comment: "comment" } as const

const excerpt = (body: Markdown) => {
  const flat = visibleText(body).replace(/\s+/g, " ").trim()
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat
}

const where = (path: FilePath | undefined, line: LineNumber | undefined) => {
  if (path === undefined) return ""
  return line === undefined ? ` on ${path}` : ` on ${path}:${line}`
}

const describe = (change: Change) => {
  if (change.kind === "checks") return `CI ${change.checks} on ${change.head.slice(0, 7)}`
  if (change.kind === "decision") return `review decision is now ${change.decision.toLowerCase().replaceAll("_", " ")}`
  if (change.kind === "ready") return "approved, checks passing and mergeable: ready to merge once the user says so"
  if (change.kind === "pushed") return `new commits pushed, head is now ${change.head.slice(0, 7)}`

  const { item } = change
  const who = item.bot ? `${item.author} (bot)` : item.author
  const what = item.kind === "review" ? `review (${(item.state ?? "").toLowerCase().replaceAll("_", " ")})` : KIND_LABELS[item.kind]
  const body = excerpt(item.body)

  return `${what} from ${who}${where(item.path, item.line)}${body === "" ? "" : `: "${body}"`} ${item.url}`
}

const heading = (pull: PullRequest) =>
  pull.role === "reviewer"
    ? `[prwatch] ${pull.key} "${pull.title}" (${pull.url}), which the user is reviewing, has updates:`
    : `[prwatch] ${pull.key} "${pull.title}" (${pull.url}) has updates:`

export const agentMessage = (pull: PullRequest, changes: readonly Change[], instructions: Text) =>
  Text.make([heading(pull), ...changes.map((change) => `- ${describe(change)}`), instructions].join("\n"))

export const notification = (pull: PullRequest, changes: readonly Change[]) => ({
  title: Text.make(`${pull.key} ${pull.title}`),
  body: Text.make(changes.map(describe).join("\n"))
})

export const summary = (changes: readonly Change[]) => Text.make(describe(changes[changes.length - 1] ?? { kind: "ready" }))
