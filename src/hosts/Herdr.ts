import { Effect, Layer, Schema } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { agentId } from "../Ids.ts"
import { Shell } from "../Shell.ts"

const AgentList = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        agent: Schema.String,
        agent_status: Schema.String,
        cwd: Schema.String,
        pane_id: Schema.String,
        terminal_title_stripped: Schema.optionalKey(Schema.String)
      })
    )
  })
})

const statusOf = (status: string) => {
  if (status === "idle" || status === "done") return "idle" as const
  if (status === "working") return "working" as const
  if (status === "blocked") return "blocked" as const

  return "unknown" as const
}

const NAME = "herdr"

export const HerdrHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell

    const agents = shell.run("herdr", ["agent", "list"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AgentList))),
      Effect.map(({ result }) =>
        result.agents.map((agent) => ({
          id: agentId(agent.pane_id),
          cwd: agent.cwd,
          label: `${agent.agent} in ${agent.pane_id}${agent.terminal_title_stripped ? ` (${agent.terminal_title_stripped})` : ""}`,
          status: statusOf(agent.agent_status)
        }))
      ),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: error.message })),
      Effect.withSpan("HerdrHost.agents")
    )

    const deliver = Effect.fn("HerdrHost.deliver")(function* (agent: string, text: string) {
      yield* shell
        .run("herdr", ["agent", "prompt", agent, text])
        .pipe(Effect.mapError((error) => new DeliveryFailed({ host: NAME, agent, reason: error.message })))
    })

    const notify = Effect.fn("HerdrHost.notify")(function* (title: string, body: string) {
      yield* shell.run("herdr", ["notification", "show", title, "--body", body, "--sound", "request"]).pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
