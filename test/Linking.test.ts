import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { Login } from "../src/Brands.ts"
import { needsPulls, resolve } from "../src/Linking.ts"
import { link, me, merged, run } from "./runs.ts"

const context = (pulls = [merged()]) => ({ viewer: me, pulls })

describe("resolve", () => {
  it("links anything with any, with no pull request", () => {
    expect(Option.map(resolve("any", run(), context([])), (linked) => linked.pr)).toEqual(Option.some(Option.none()))
  })

  it("links a run only when you triggered it with actor", () => {
    expect(Option.isSome(resolve("actor", run(), context()))).toBe(true)
    expect(Option.isNone(resolve("actor", run({ triggering_actor: { login: "other" } }), context()))).toBe(true)
  })

  it("links the merge commit of your merged pull request, and nobody else's", () => {
    expect(Option.map(resolve("merge-commit", run(), context()), (linked) => linked.pr)).toEqual(Option.some(Option.some("acme/shop#7")))
    expect(Option.isNone(resolve("merge-commit", run(), context([merged({ author: Login.make("other") })])))).toBe(true)
    expect(Option.isNone(resolve("merge-commit", run({ head_sha: "0000000" }), context()))).toBe(true)
  })

  it("links an open pull request of yours by its head commit", () => {
    const open = merged({ open: true, merged: false, mergeCommit: Option.none() })
    const onHead = run({ head_sha: "feedbee" })

    expect(Option.map(resolve("pr-head-sha", onHead, context([open])), (linked) => linked.pr)).toEqual(
      Option.some(Option.some("acme/shop#7"))
    )
    expect(Option.isNone(resolve("pr-head-sha", run(), context([open])))).toBe(true)
  })

  it("links any pull request that matches the commit for a claim, but only to the panes that claimed it", () => {
    const linked = resolve("claim", run(), context([merged({ author: Login.make("other") })]))

    expect(Option.map(linked, (found) => found.claimantsOnly)).toEqual(Option.some(true))
  })

  it("extracts a pull request number, a branch or a commit from a field with a regular expression", () => {
    const titled = run({ display_title: "Deploy #42 to production" })
    const pr = link({ extract: { from: "display_title", regex: "#(\\d+)", as: "pr-number" } })
    const branch = link({ extract: { from: "display_title", regex: "to (\\w+)", as: "branch" } })

    expect(Option.map(resolve(pr, titled, context([])), (linked) => linked.pr)).toEqual(Option.some(Option.some("acme/shop#42")))
    expect(Option.map(resolve(branch, titled, context([])), (linked) => linked.branch)).toEqual(Option.some(Option.some("production")))
    expect(Option.isNone(resolve(pr, run(), context([])))).toBe(true)
  })
})

describe("needsPulls", () => {
  it("is true only for the links that find a pull request from a commit", () => {
    expect(["any", "actor", "pr-head-sha", "merge-commit", "claim"].map((kind) => needsPulls(link(kind)))).toEqual([
      false,
      false,
      true,
      true,
      true
    ])
  })
})
