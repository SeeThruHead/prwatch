import { DateTime, Schema } from "effect"

export const RepoSlug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/, { message: "Expected owner/name" })),
  Schema.brand("RepoSlug")
)
export type RepoSlug = typeof RepoSlug.Type

export const Branch = Schema.NonEmptyString.pipe(Schema.brand("Branch"))
export type Branch = typeof Branch.Type

export const AgentId = Schema.NonEmptyString.pipe(Schema.brand("AgentId"))
export type AgentId = typeof AgentId.Type

export const PrKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+#\d+$/, { message: "Expected owner/name#number" })),
  Schema.brand("PrKey")
)
export type PrKey = typeof PrKey.Type

export const PrNumber = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand("PrNumber"))
export type PrNumber = typeof PrNumber.Type

export const NodeId = Schema.NonEmptyString.pipe(Schema.brand("NodeId"))
export type NodeId = typeof NodeId.Type

export const Sha = Schema.String.pipe(Schema.brand("Sha"))
export type Sha = typeof Sha.Type

export const Login = Schema.String.pipe(Schema.brand("Login"))
export type Login = typeof Login.Type

export const Url = Schema.String.pipe(Schema.brand("Url"))
export type Url = typeof Url.Type

export const IsoTime = Schema.String.pipe(Schema.brand("IsoTime"))
export type IsoTime = typeof IsoTime.Type

export const Markdown = Schema.String.pipe(Schema.brand("Markdown"))
export type Markdown = typeof Markdown.Type

export const Text = Schema.String.pipe(Schema.brand("Text"))
export type Text = typeof Text.Type

export const FilePath = Schema.String.pipe(Schema.brand("FilePath"))
export type FilePath = typeof FilePath.Type

export const LineNumber = Schema.Int.pipe(Schema.brand("LineNumber"))
export type LineNumber = typeof LineNumber.Type

export const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.brand("Count"))
export type Count = typeof Count.Type

export const Fingerprint = Schema.String.pipe(Schema.brand("Fingerprint"))
export type Fingerprint = typeof Fingerprint.Type

export const Stdout = Schema.String.pipe(Schema.brand("Stdout"))
export type Stdout = typeof Stdout.Type

export const HostName = Schema.Literals(["herdr", "cmux", "orca", "tmux", "claude"])
export type HostName = typeof HostName.Type

export const NotifySound = Schema.Literals(["none", "done", "request"])
export type NotifySound = typeof NotifySound.Type

export const ReviewDecision = Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
export type ReviewDecision = typeof ReviewDecision.Type

export const ReviewState = Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"])
export type ReviewState = typeof ReviewState.Type

export const RuleName = Schema.NonEmptyString.pipe(Schema.brand("RuleName"))
export type RuleName = typeof RuleName.Type

export const Glob = Schema.NonEmptyString.pipe(Schema.brand("Glob"))
export type Glob = typeof Glob.Type

export const RegexSource = Schema.NonEmptyString.pipe(Schema.brand("RegexSource"))
export type RegexSource = typeof RegexSource.Type

export const FieldPath = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_]\w*(\.\w+)*$/, { message: "Expected a dotted field path such as head_branch or app.slug" })),
  Schema.brand("FieldPath")
)
export type FieldPath = typeof FieldPath.Type

export const CommandLine = Schema.NonEmptyString.pipe(Schema.brand("CommandLine"))
export type CommandLine = typeof CommandLine.Type

export const SourceKind = Schema.Literals(["workflow_run", "check_run", "commit_status", "deployment", "release"])
export type SourceKind = typeof SourceKind.Type

export const RunOutcome = Schema.Literals(["started", "succeeded", "failed", "cancelled", "completed"])
export type RunOutcome = typeof RunOutcome.Type

export const NotifyTarget = Schema.Literals(["pane", "menubar"])
export type NotifyTarget = typeof NotifyTarget.Type

export const LinkKind = Schema.Literals(["actor", "merge-commit", "pr-head-sha", "claim", "any"])
export type LinkKind = typeof LinkKind.Type

export const ExtractedKind = Schema.Literals(["pr-number", "branch", "sha"])
export type ExtractedKind = typeof ExtractedKind.Type

export const RunKey = Schema.NonEmptyString.pipe(Schema.brand("RunKey"))
export type RunKey = typeof RunKey.Type

export const RunId = Schema.Int.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const Hostname = Schema.NonEmptyString.pipe(Schema.brand("Hostname"))
export type Hostname = typeof Hostname.Type

export const repoSlug = Schema.decodeSync(RepoSlug)
export const branch = Schema.decodeSync(Branch)
export const agentId = Schema.decodeSync(AgentId)

export const prKey = (repo: RepoSlug, number: PrNumber): PrKey => PrKey.make(`${repo}#${number}`)

export const sameRepo = (left: RepoSlug, right: RepoSlug) => left.toLowerCase() === right.toLowerCase()

export const isoTime = (time: DateTime.DateTime) => IsoTime.make(DateTime.formatIso(time))
