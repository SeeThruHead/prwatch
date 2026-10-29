import { Effect, Layer, Schema } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { agentId } from "../Ids.ts"
import { Shell } from "../Shell.ts"

const NAME = "orca"

const Terminals = Schema.Struct({
  result: Schema.Struct({
    terminals: Schema.Array(
      Schema.Struct({
        handle: Schema.String,
        worktreePath: Schema.String,
        title: Schema.String,
        connected: Schema.Boolean,
        writable: Schema.Boolean,
        agentIdentity: Schema.optional(Schema.String)
      })
    )
  })
})

export const agentsOf = (terminals: Schema.Schema.Type<typeof Terminals>["result"]["terminals"]) =>
  terminals.flatMap((terminal) =>
    terminal.agentIdentity === undefined || !terminal.connected || !terminal.writable
      ? []
      : [
          {
            id: agentId(terminal.handle),
            cwd: terminal.worktreePath,
            label: `${terminal.agentIdentity} in orca "${terminal.title}"`,
            status: "unknown" as const
          }
        ]
  )

// orca has no notification command, so this goes through macOS Notification Center
const NOTIFY_SCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"]

export const OrcaHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell

    const agents = shell.run("orca", ["terminal", "list", "--json"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Terminals))),
      Effect.map(({ result }) => agentsOf(result.terminals)),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: error.message })),
      Effect.withSpan("OrcaHost.agents")
    )

    const deliver = Effect.fn("OrcaHost.deliver")(function* (agent: string, text: string) {
      yield* shell
        .run("orca", ["terminal", "send", "--terminal", agent, "--text", text, "--enter"])
        .pipe(Effect.mapError((error) => new DeliveryFailed({ host: NAME, agent, reason: error.message })))
    })

    const notify = Effect.fn("OrcaHost.notify")(function* (title: string, body: string) {
      yield* shell
        .run("osascript", [...NOTIFY_SCRIPT.flatMap((line) => ["-e", line]), `prwatch: ${title}`, body.split("\n")[0] ?? ""])
        .pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
