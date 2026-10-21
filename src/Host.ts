import { Context, Effect, Schema } from "effect"

import type { AgentId } from "./Ids.ts"

export class HostUnavailable extends Schema.TaggedError<HostUnavailable>()("HostUnavailable", {
  host: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `${this.host} is not reachable: ${this.reason}`
  }
}

export class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
  host: Schema.String,
  agent: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `could not send to ${this.agent} in ${this.host}: ${this.reason}`
  }
}

export class Host extends Context.Service<
  Host,
  {
    readonly name: string
    readonly agents: Effect.Effect<
      readonly {
        readonly id: AgentId
        readonly cwd: string
        readonly label: string
        readonly status: "idle" | "working" | "blocked" | "unknown"
      }[],
      HostUnavailable
    >
    readonly deliver: (agent: AgentId, text: string) => Effect.Effect<void, DeliveryFailed>
    readonly notify: (title: string, body: string) => Effect.Effect<void>
  }
>()("prwatch/Host") {}

export type Agent = Effect.Success<Context.Service.Shape<typeof Host>["agents"]>[number]
