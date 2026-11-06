import { describe, expect, it } from "vitest"

import { IsoTime, NodeId, Sha, Text } from "../src/Brands.ts"
import { OUTSIDE_HEADER, agentMessage, fromOutside, notification, quoted, shortQuote, summary } from "../src/Message.ts"
import { item, pull } from "./fixtures.ts"

describe("agentMessage", () => {
  it("puts the URL under the heading, groups by author, and gives each comment its location, quote and link", () => {
    const message = agentMessage(
      pull(),
      [{ kind: "item", item: item({ id: "a", path: "src/x.ts", line: 4 }) }],
      Text.make("Show the user first.")
    )

    expect(message).toBe(
      [
        '[prwatch] acme/app#1 "Add the thing" has updates:',
        "https://github.com/acme/app/pull/1",
        "",
        "reviewer:",
        '  - src/x.ts:4: "Could this be simpler?"',
        "    https://github.com/acme/app/pull/1#a",
        "",
        "Show the user first."
      ].join("\n")
    )
  })

  it("drops markup that bots wrap their comments in", () => {
    const body = "<!-- generated --> **Minor** <details><summary>log</summary>noise</details> Use a const here."
    const message = agentMessage(
      pull(),
      [{ kind: "item", item: item({ id: "b", kind: "comment", bot: true, author: "coderabbitai", body }) }],
      Text.make("")
    )

    expect(message).toContain('coderabbitai (bot):\n  - comment: "Minor Use a const here."')
  })

  it("collapses reviews with no text into one count per author", () => {
    const review = (id: string, state: "COMMENTED" | "APPROVED") => ({
      kind: "item" as const,
      item: item({ id, kind: "review", state, author: "jo", body: "" })
    })
    const message = agentMessage(pull(), [review("r1", "COMMENTED"), review("r2", "COMMENTED")], Text.make(""))
    const mixed = agentMessage(pull(), [review("r1", "COMMENTED"), review("r2", "APPROVED")], Text.make(""))

    expect(message.split("\n").slice(3)).toEqual(["jo: 2 reviews (commented), no text"])
    expect(mixed).toContain("jo: 2 reviews (1 commented, 1 approved), no text")
    expect(message).not.toContain("#r1")
  })

  it("keeps a review that has text as its own item", () => {
    const message = agentMessage(
      pull(),
      [{ kind: "item", item: item({ id: "r", kind: "review", state: "CHANGES_REQUESTED", body: "Needs tests." }) }],
      Text.make("")
    )

    expect(message).toContain('  - review (changes requested): "Needs tests."')
  })

  it("shows a GitHub alert banner shared by every comment from an author once, next to the author", () => {
    const banner = "> [!NOTE]\n> AI agent review, not yet read by the user\n\n"
    const message = agentMessage(
      pull(),
      [
        { kind: "item", item: item({ id: "r", kind: "review", state: "COMMENTED", body: "" }) },
        { kind: "item", item: item({ id: "a", path: "src/a.ts", body: `${banner}Rename this.` }) },
        { kind: "item", item: item({ id: "b", path: "src/b.ts", line: 9, body: `${banner}> quoted\nDrop the cast.` }) }
      ],
      Text.make("")
    )

    expect(message.split("\n").slice(3)).toEqual([
      'reviewer, each comment opens with "AI agent review, not yet read by the user":',
      "  - 1 review (commented), no text",
      '  - src/a.ts: "Rename this."',
      "    https://github.com/acme/app/pull/1#a",
      '  - src/b.ts:9: "quoted Drop the cast."',
      "    https://github.com/acme/app/pull/1#b"
    ])
  })

  it("keeps a banner on the comment when the author's comments do not all share it", () => {
    const message = agentMessage(
      pull(),
      [
        { kind: "item", item: item({ id: "a", body: "> [!WARNING]\n> Breaking change\n\nBumps the API." }) },
        { kind: "item", item: item({ id: "b", body: "Looks fine otherwise." }) }
      ],
      Text.make("")
    )

    expect(message).toContain('reviewer:\n  - review comment: "(Breaking change) Bumps the API."')
    expect(message).toContain('  - review comment: "Looks fine otherwise."')
  })

  it("lists status changes before the comments, and authors in the order they first spoke", () => {
    const message = agentMessage(
      pull(),
      [
        { kind: "item", item: item({ id: "a", author: "jo", body: "First." }) },
        { kind: "pushed", head: Sha.make("fff9999abc") },
        { kind: "item", item: item({ id: "b", author: "sam", body: "Second." }) },
        { kind: "item", item: item({ id: "c", author: "jo", body: "Third." }) }
      ],
      Text.make("")
    )

    expect(message.split("\n").filter((line) => !line.startsWith("    "))).toEqual([
      '[prwatch] acme/app#1 "Add the thing" has updates:',
      "https://github.com/acme/app/pull/1",
      "",
      "- new commits pushed, head is now fff9999",
      "",
      "jo:",
      '  - review comment: "First."',
      '  - review comment: "Third."',
      "",
      "sam:",
      '  - review comment: "Second."'
    ])
  })
})

describe("shortQuote", () => {
  it("keeps the leading sentences that fit in 120 characters, and marks what it left out", () => {
    const second = "This second sentence is long enough that the two of them together go well past the limit we set for a quote."

    expect(shortQuote(Text.make(`Use a const here. ${second}`))).toBe("Use a const here. …")
    expect(shortQuote(Text.make("Nit. Use a const here."))).toBe("Nit. Use a const here.")
  })

  it("cuts a first sentence longer than the limit at a word", () => {
    const quote = shortQuote(Text.make(`${"word ".repeat(40)}end.`))

    expect(quote.length).toBeLessThanOrEqual(121)
    expect(quote).toMatch(/word…$/)
  })
})

describe("quoted", () => {
  it("strips blockquote markers, headings, links, images and emphasis", () => {
    const body = "### Potential issue\n> earlier text\n**Bold** and [a link](https://x.test) ![img](https://x.test/i.png)"

    expect(quoted(item({ id: "q", body })).quote).toBe("Potential issue: earlier text Bold and a link")
  })
})

describe("fromOutside", () => {
  it("sets the caution apart from the quoted text with a blank line", () => {
    expect(fromOutside(Text.make("[prwatch] hello"))).toBe(`${OUTSIDE_HEADER}\n\n[prwatch] hello`)
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
        '[prwatch] acme/app#1 "Add the thing" has updates:',
        "https://github.com/acme/app/pull/1",
        "",
        "- entered the merge queue",
        "- removed from the merge queue: failed checks",
        "- merged as a0f6b93",
        "",
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
