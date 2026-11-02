import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { Url } from "../src/Brands.ts"
import { remoteOf } from "../src/Workspace.ts"

describe("remoteOf", () => {
  it.each([
    ["git@github.com:acme/app.git", "github.com", "acme/app"],
    ["https://github.com/acme/app", "github.com", "acme/app"],
    ["https://github.com/acme/app.git\n", "github.com", "acme/app"],
    ["ssh://git@github.com/acme/my.repo.git", "github.com", "acme/my.repo"],
    ["ssh://git@gitea.example.lan:2223/sth/homelab.git", "gitea.example.lan", "sth/homelab"],
    ["https://Gitea.Example.Lan/sth/homelab", "gitea.example.lan", "sth/homelab"]
  ])("reads %s", (remote, host, repo) => {
    expect(remoteOf(Url.make(remote))).toEqual(Option.some({ host, repo }))
  })

  it("ignores something that is not a remote", () => {
    expect(remoteOf(Url.make("not a remote"))).toEqual(Option.none())
  })
})
