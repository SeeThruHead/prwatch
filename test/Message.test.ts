import { describe, expect, it } from "vitest"

import { IsoTime, NodeId, Sha, Text } from "../src/Brands.ts"
import { agentMessage, notification, summary } from "../src/Message.ts"
import { item, pull } from "./fixtures.ts"

describe("agentMessage", () => {
  it("names the pull request, each change with its location, and the instructions", () => {
    const message = agentMessage(
      pull(),
      [{ kind: "item", item: item({ id: "a", path: "src/x.ts", line: 4 }) }],
      Text.make("Show the user first.")
    )

    expect(message).toBe(
      [
        '[prwatch] acme/app#1 "Add the thing" (https://github.com/acme/app/pull/1) has updates:',
        '- review comment from reviewer on src/x.ts:4: "Could this be simpler?" https://github.com/acme/app/pull/1#a',
        "Show the user first."
      ].join("\n")
    )
  })

  it("drops markup that bots wrap their comments in", () => {
    const body = "<!-- generated --> **Minor** <details><summary>log</summary>noise</details> Use a const here."
    const message = agentMessage(
      pull(),
      [{ kind: "item", item: item({ id: "b", bot: true, author: "coderabbitai", body }) }],
      Text.make("")
    )

    expect(message).toContain('from coderabbitai (bot): "**Minor** Use a const here."')
  })
})

describe("lifecycle messages", () => {
  const at = IsoTime.make("2026-01-01T00:00:00Z")
  const id = (value: string) => NodeId.make(value)

  it("says a pull request entered the queue, was removed with GitHub's reason, and merged as which commit", () => {
    const message = agentMessage(
      pull(),
      [
        { kind: "lifecycle", event: { id: id("q"), kind: "queued", at } },
        { kind: "lifecycle", event: { id: id("r"), kind: "unqueued", at, reason: Text.make("failed_checks") } },
        { kind: "lifecycle", event: { id: id("m"), kind: "merged", at, commit: Sha.make("a0f6b9396a5b03af3ccb6d35661d26793c040596") } }
      ],
      Text.make("Done.")
    )

    expect(message).toBe(
      [
        '[prwatch] acme/app#1 "Add the thing" (https://github.com/acme/app/pull/1) has updates:',
        "- entered the merge queue",
        "- removed from the merge queue: failed checks",
        "- merged as a0f6b93",
        "Done."
      ].join("\n")
    )
  })

  it("puts the latest lifecycle change in the notification and the menu bar summary", () => {
    const merged = [{ kind: "lifecycle" as const, event: { id: id("m"), kind: "merged" as const, at, commit: Sha.make("a0f6b93") } }]

    expect(notification(pull(), merged).body).toBe("merged as a0f6b93")
    expect(summary(merged)).toBe("merged as a0f6b93")
  })
})
