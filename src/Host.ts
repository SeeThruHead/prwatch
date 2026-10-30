import { Context, Effect, Schema } from "effect"

import { AgentId, FilePath, HostName, Text } from "./Brands.ts"

export class HostUnavailable extends Schema.TaggedError<HostUnavailable>()("HostUnavailable", {
  host: HostName,
  reason: Text
}) {
  override get message() {
    return `${this.host} is not reachable: ${this.reason}`
  }
}

export class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
  host: HostName,
  agent: AgentId,
  reason: Text
}) {
  override get message() {
    return `could not send to ${this.agent} in ${this.host}: ${this.reason}`
  }
}

export type Agent = {
  readonly id: AgentId
  readonly cwd: FilePath
  readonly label: Text
  readonly program?: Text
  readonly status: "idle" | "working" | "blocked" | "unknown"
}

export class Host extends Context.Service<
  Host,
  {
    readonly name: HostName
    readonly agents: Effect.Effect<readonly Agent[], HostUnavailable>
    readonly deliver: (agent: AgentId, text: Text) => Effect.Effect<void, DeliveryFailed>
    readonly notify: (title: Text, body: Text) => Effect.Effect<void>
  }
>()("prwatch/Host") {}
