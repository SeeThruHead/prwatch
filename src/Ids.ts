import { Schema } from "effect"

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

export const repoSlug = Schema.decodeSync(RepoSlug)
export const branch = Schema.decodeSync(Branch)
export const agentId = Schema.decodeSync(AgentId)

export const prKey = (repo: RepoSlug, number: number): PrKey => Schema.decodeSync(PrKey)(`${repo}#${number}`)

export const sameRepo = (left: RepoSlug, right: RepoSlug) => left.toLowerCase() === right.toLowerCase()
