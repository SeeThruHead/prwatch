import { Predicate } from "effect"

import { Text } from "./Brands.ts"
import { sourceOf } from "./Matcher.ts"
import type { Link, Rule } from "./Rules.ts"

const linkText = (link: Link) => (Predicate.isObject(link) ? `link ${link.extract.as} from ${link.extract.from}` : `link ${link}`)

export const describeRule = (rule: Rule): Text =>
  Text.make(
    [
      `${sourceOf(rule)} in ${rule.repos.join(", ")}`,
      linkText(rule.link),
      `${rule.notify.on.join("/")} to ${rule.notify.to.join(" and ")}`,
      ...(rule.command === undefined ? [] : ["with a command"]),
      ...(rule.machines === undefined ? [] : [`on ${rule.machines.join(", ")}`])
    ].join(" · ")
  )
