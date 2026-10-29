const PRIMITIVES = new Set(["String", "Number", "NonEmptyString", "Int", "Finite"])

type Node = { readonly type: string; readonly parent?: Node } & Record<string, unknown>

const isSchemaMember = (node: Node, names: ReadonlySet<string>) => {
  const object = node.object as Node | undefined
  const property = node.property as Node | undefined
  if (object?.type !== "Identifier" || object.name !== "Schema") return false

  return property?.type === "Identifier" && names.has(String(property.name))
}

const isBrandCall = (node: Node) => node.type === "CallExpression" && isSchemaMember(node.callee as Node, new Set(["brand"]))

const brandedHere = (node: Node) => {
  const pipe = node.parent
  if (pipe?.type !== "MemberExpression" || (pipe.property as Node).name !== "pipe") return false
  const call = pipe.parent

  return call?.type === "CallExpression" && (call.arguments as readonly Node[]).some(isBrandCall)
}

type Context = { readonly report: (report: { readonly node: Node; readonly message: string }) => void }

const branded = {
  meta: { type: "problem", docs: { description: "require Schema brands or literal unions instead of bare strings and numbers" } },
  create: (context: Context) => ({
    TSStringKeyword: (node: Node) =>
      context.report({ node, message: "Use a branded type (src/Brands.ts) or a literal union instead of string." }),
    TSNumberKeyword: (node: Node) =>
      context.report({ node, message: "Use a branded type (src/Brands.ts) or a literal union instead of number." }),
    MemberExpression: (node: Node) => {
      if (!isSchemaMember(node, PRIMITIVES) || brandedHere(node)) return

      context.report({ node, message: "Pipe this into Schema.brand(...), or use a brand from src/Brands.ts." })
    }
  })
}

export default { meta: { name: "prwatch" }, rules: { branded } }
