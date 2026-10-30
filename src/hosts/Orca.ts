import { Effect, Layer, Schema } from "effect"

import { DeliveryFailed, Host, HostUnavailable, StartFailed } from "../Host.ts"
import { AgentId, FilePath, type RepoSlug, Text } from "../Brands.ts"
import { Shell } from "../Shell.ts"

const NAME = "orca" as const

const Terminal = Schema.Struct({
  handle: AgentId,
  worktreePath: FilePath,
  title: Text,
  connected: Schema.Boolean,
  writable: Schema.Boolean,
  agentIdentity: Schema.optional(Text)
})

const Terminals = Schema.Struct({ result: Schema.Struct({ terminals: Schema.Array(Terminal) }) })

const Repo = Schema.Struct({
  path: FilePath,
  gitRemoteIdentity: Schema.optional(Schema.NullOr(Schema.Struct({ canonicalKey: Text })))
})

const Repos = Schema.Struct({ result: Schema.Struct({ repos: Schema.Array(Repo) }) })

export const checkoutOf = (repos: readonly (typeof Repo.Type)[], repo: RepoSlug) =>
  repos.find((candidate) => candidate.gitRemoteIdentity?.canonicalKey.toLowerCase() === `github.com/${repo}`.toLowerCase())?.path

const isAgent = (terminal: typeof Terminal.Type) => {
  if (terminal.agentIdentity === undefined) return false
  if (!terminal.connected) return false

  return terminal.writable
}

export const agentsOf = (terminals: readonly (typeof Terminal.Type)[]) =>
  terminals.filter(isAgent).map((terminal) => ({
    id: terminal.handle,
    cwd: terminal.worktreePath,
    ...(terminal.agentIdentity === undefined ? {} : { program: terminal.agentIdentity }),
    label: Text.make(`${terminal.agentIdentity} in orca "${terminal.title}"`),
    status: "unknown" as const
  }))

const NOTIFY_SCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"]

export const OrcaHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell

    const agents = shell.run("orca", ["terminal", "list", "--json"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Terminals))),
      Effect.map(({ result }) => agentsOf(result.terminals)),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: Text.make(error.message) })),
      Effect.withSpan("OrcaHost.agents")
    )

    const deliver = Effect.fn("OrcaHost.deliver")(function* (agent: AgentId, text: Text) {
      yield* shell
        .run("orca", ["terminal", "send", "--terminal", agent, "--text", text, "--enter"])
        .pipe(Effect.mapError((error) => new DeliveryFailed({ host: NAME, agent, reason: Text.make(error.message) })))
    })

    const notify = Effect.fn("OrcaHost.notify")(function* (title: Text, body: Text) {
      yield* shell
        .run("osascript", [...NOTIFY_SCRIPT.flatMap((line) => ["-e", line]), `prwatch: ${title}`, body.split("\n")[0] ?? ""])
        .pipe(Effect.ignore)
    })

    const start = Effect.fn("OrcaHost.start")(function* (repo: RepoSlug, prompt: Text) {
      const failed = (reason: Text) => new StartFailed({ host: NAME, repo, reason })
      const { result } = yield* shell.run("orca", ["repo", "list", "--json"]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Repos))),
        Effect.mapError((error) => failed(Text.make(error.message)))
      )
      const checkout = checkoutOf(result.repos, repo)
      if (checkout === undefined) return yield* failed(Text.make("no orca repo has it as its origin"))

      yield* shell
        .run("orca", ["agent", "launch", "--agent", "claude", "--worktree", `path:${checkout}`, "--prompt", prompt, "--focus", "--json"])
        .pipe(Effect.mapError((error) => failed(Text.make(error.message))))

      return Text.make(`claude in orca at ${checkout}`)
    })

    return Host.of({ name: NAME, agents, deliver, notify, start })
  })
)
