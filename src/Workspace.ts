import { Context, Effect, Layer, Option, Schema } from "effect"

import { Branch, type FilePath, type ForgeHost, RepoSlug, Sha, Text, Url, forgeHost } from "./Brands.ts"
import { Shell } from "./Shell.ts"

const REMOTE = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i

export const remoteOf = (url: Url): Option.Option<{ readonly host: ForgeHost; readonly repo: RepoSlug }> => {
  const match = REMOTE.exec(url.trim())
  const host = match?.[1]
  const slug = match?.[2]
  if (host === undefined || slug === undefined) return Option.none()

  return Option.map(Schema.decodeUnknownOption(RepoSlug)(slug), (repo) => ({ host: forgeHost(Text.make(host)), repo }))
}

type GitArg = "remote" | "get-url" | "origin" | "rev-parse" | "--abbrev-ref" | "HEAD"

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly locate: (cwd: FilePath) => Effect.Effect<
      Option.Option<{
        readonly host: ForgeHost
        readonly repo: RepoSlug
        readonly branch: Option.Option<Branch>
        readonly commit: Sha
      }>
    >
  }
>()("prwatch/Workspace") {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const shell = yield* Shell

      const git = (cwd: FilePath, args: readonly GitArg[]) => Effect.map(shell.run("git", ["-C", cwd, ...args]), (out) => out.trim())

      const locate = Effect.fn("Workspace.locate")(function* (cwd: FilePath) {
        const [remote, head, commit] = yield* Effect.all(
          [git(cwd, ["remote", "get-url", "origin"]), git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), git(cwd, ["rev-parse", "HEAD"])],
          { concurrency: 3 }
        )
        const branch = head === "HEAD" ? Option.none() : Schema.decodeUnknownOption(Branch)(head)

        return Option.map(remoteOf(Url.make(remote)), (where) => ({ ...where, branch, commit: Sha.make(commit) }))
      }, Effect.orElseSucceed(Option.none))

      return Workspace.of({ locate })
    })
  )
}
