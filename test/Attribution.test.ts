import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { findAttribution, scanRepository } from "../tools/attribution.ts"

describe("no AI attribution", () => {
  it("catches co-author trailers, generated-with lines and the robot emoji", () => {
    const message = [
      "Fix the reaper",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "Generated with Claude Code",
      "\u{1F916} made by a bot"
    ].join("\n")
    expect(findAttribution("message", message).map((finding) => finding.line)).toEqual([3, 4, 5])
  })

  it("leaves ordinary text alone", () => {
    expect(findAttribution("css", "button{cursor:pointer}\nCo-Authored-By: Jane Doe <jane@example.com>")).toEqual([])
  })

  it.effect("the repository and its history are clean", () =>
    Effect.gen(function* () {
      expect(yield* scanRepository()).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
