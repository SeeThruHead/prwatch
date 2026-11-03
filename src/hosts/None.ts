import { Effect, Layer } from "effect"

import { DeliveryFailed, Host } from "../Host.ts"
import { Text } from "../Brands.ts"

export const NoHost = Layer.succeed(
  Host,
  Host.of({
    name: "tmux",
    agents: Effect.succeed([]),
    deliver: (agent) => Effect.fail(new DeliveryFailed({ host: "tmux", agent, reason: Text.make("no multiplexer is listed in delivery") })),
    notify: () => Effect.void
  })
)
