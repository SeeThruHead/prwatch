import { Config, Effect, Layer, Schema } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { AgentId, FilePath, NotifySound, Text } from "../Brands.ts"
import { Shell } from "../Shell.ts"

const HerdrStatus = Schema.String.pipe(Schema.brand("HerdrStatus"))

const AgentList = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        agent: Text,
        agent_status: HerdrStatus,
        cwd: FilePath,
        pane_id: AgentId,
        terminal_title_stripped: Schema.optionalKey(Text)
      })
    )
  })
})

const statusOf = (status: typeof HerdrStatus.Type) => {
  if (status === "idle" || status === "done") return "idle" as const
  if (status === "working") return "working" as const
  if (status === "blocked") return "blocked" as const

  return "unknown" as const
}

const NAME = "herdr" as const

export const notifyArgs = (title: Text, body: Text, sound: NotifySound) => ["notification", "show", title, "--body", body, "--sound", sound]

export const HerdrHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell
    const sound = yield* Config.Literals(NotifySound.literals, "PRWATCH_NOTIFY_SOUND").pipe(Config.withDefault("none"))

    const agents = shell.run("herdr", ["agent", "list"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AgentList))),
      Effect.map(({ result }) =>
        result.agents.map((agent) => ({
          id: agent.pane_id,
          cwd: agent.cwd,
          label: Text.make(
            `${agent.agent} in ${agent.pane_id}${agent.terminal_title_stripped ? ` (${agent.terminal_title_stripped})` : ""}`
          ),
          status: statusOf(agent.agent_status)
        }))
      ),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: Text.make(error.message) })),
      Effect.withSpan("HerdrHost.agents")
    )

    const deliver = Effect.fn("HerdrHost.deliver")(function* (agent: AgentId, text: Text) {
      yield* shell
        .run("herdr", ["agent", "prompt", agent, text])
        .pipe(Effect.mapError((error) => new DeliveryFailed({ host: NAME, agent, reason: Text.make(error.message) })))
    })

    const notify = Effect.fn("HerdrHost.notify")(function* (title: Text, body: Text) {
      yield* shell.run("herdr", notifyArgs(title, body, sound)).pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
