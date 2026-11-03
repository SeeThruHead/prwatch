import type { HostName } from "./Brands.ts"
import type { Delivery } from "./Rules.ts"

export const DEFAULT_DELIVERY: Delivery = ["herdr", "cmux", "orca", "tmux", "claude"]

export type Multiplexer = Exclude<HostName, "claude">

export type SocketOrder = "first" | "last" | "off"

export type DeliveryPlan = { readonly multiplexers: readonly Multiplexer[]; readonly socket: SocketOrder }

const isMultiplexer = (host: HostName): host is Multiplexer => host !== "claude"

const socketOrder = (order: Delivery): SocketOrder => {
  const claude = order.indexOf("claude")
  if (claude === -1) return "off"

  return order.slice(0, claude).some(isMultiplexer) ? "last" : "first"
}

export const planOf = (order: Delivery): DeliveryPlan => ({ multiplexers: order.filter(isMultiplexer), socket: socketOrder(order) })
