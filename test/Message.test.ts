import { describe, expect, it } from "vitest"

import { Text, Url } from "../src/Brands.ts"
import { agentMessage, checkMessage, startMessage } from "../src/Message.ts"
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

describe("checkMessage", () => {
  it("asks the author's agent which comments are still open", () => {
    expect(checkMessage(pull(), Text.make("Show the user first."))).toBe(
      [
        '[prwatch] the user asked you to check the comments on acme/app#1 "Add the thing" (https://github.com/acme/app/pull/1).',
        "Read every review thread and comment with gh and tell the user which are resolved, which are still open, and what each open one needs.",
        "Show the user first."
      ].join("\n")
    )
  })

  it("asks a reviewer's agent what the author has addressed", () => {
    expect(checkMessage(pull({ role: "reviewer" }), Text.make(""))).toContain("which the author has addressed")
  })
})

describe("startMessage", () => {
  it("links the pull request, asks the prompt, and keeps the agent off this checkout's branch", () => {
    const message = startMessage(
      Url.make("https://github.com/acme/app/pull/1"),
      Text.make("Check the comments."),
      Text.make("Show the user first.")
    )

    expect(message.split("\n")).toEqual([
      "https://github.com/acme/app/pull/1",
      "Check the comments.",
      "If you need the pull request's code, use the existing worktree on its branch if there is one (git worktree list), otherwise create a new worktree for it. Never switch the branch of this checkout.",
      "Show the user first."
    ])
  })
})
