import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { Url } from "../src/Brands.ts"
import { slugFromRemote } from "../src/Workspace.ts"

describe("slugFromRemote", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git\n", "acme/app"],
    ["ssh://git@github.com/acme/my.repo.git", "acme/my.repo"]
  ])("reads %s", (remote, slug) => {
    expect(slugFromRemote(Url.make(remote))).toEqual(Option.some(slug))
  })

  it("ignores remotes that are not GitHub", () => {
    expect(slugFromRemote(Url.make("git@gitlab.com:acme/app.git"))).toEqual(Option.none())
  })
})
