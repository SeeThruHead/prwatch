import { Context, Effect, Layer, Option, Schema } from "effect"

import { Branch, RepoSlug } from "./Ids.ts"
import { Shell } from "./Shell.ts"

const SLUG = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

export const slugFromRemote = (url: string) =>
  Option.flatMap(Option.fromNullishOr(SLUG.exec(url.trim())?.[1]), Schema.decodeUnknownOption(RepoSlug))

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly locate: (
      cwd: string
    ) => Effect.Effect<Option.Option<{ readonly repo: RepoSlug; readonly branch: Option.Option<Branch>; readonly commit: string }>>
  }
>()("prwatch/Workspace") {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const shell = yield* Shell

      const git = (cwd: string, args: readonly string[]) => Effect.map(shell.run("git", ["-C", cwd, ...args]), (out) => out.trim())

      const locate = Effect.fn("Workspace.locate")(function* (cwd: string) {
        const [remote, head, commit] = yield* Effect.all(
          [git(cwd, ["remote", "get-url", "origin"]), git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), git(cwd, ["rev-parse", "HEAD"])],
          { concurrency: 3 }
        )
        const branch = head === "HEAD" ? Option.none() : Schema.decodeUnknownOption(Branch)(head)

        return Option.map(slugFromRemote(remote), (repo) => ({ repo, branch, commit }))
      }, Effect.orElseSucceed(Option.none))

      return Workspace.of({ locate })
    })
  )
}
