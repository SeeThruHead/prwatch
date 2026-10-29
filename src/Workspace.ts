import { Context, Effect, Layer, Option, Schema } from "effect"

import { Branch, FilePath, RepoSlug, Sha, Url } from "./Brands.ts"
import { Shell } from "./Shell.ts"

const SLUG = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

export const slugFromRemote = (url: Url) =>
  Option.flatMap(Option.fromNullishOr(SLUG.exec(url.trim())?.[1]), Schema.decodeUnknownOption(RepoSlug))

type GitArg = "remote" | "get-url" | "origin" | "rev-parse" | "--abbrev-ref" | "HEAD"

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly locate: (
      cwd: FilePath
    ) => Effect.Effect<Option.Option<{ readonly repo: RepoSlug; readonly branch: Option.Option<Branch>; readonly commit: Sha }>>
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

        return Option.map(slugFromRemote(Url.make(remote)), (repo) => ({ repo, branch, commit: Sha.make(commit) }))
      }, Effect.orElseSucceed(Option.none))

      return Workspace.of({ locate })
    })
  )
}
