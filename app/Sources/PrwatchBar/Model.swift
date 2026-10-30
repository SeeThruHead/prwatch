import Foundation

struct Pull: Decodable, Hashable, Identifiable {
  let key: String
  let title: String
  let url: String
  let needsYou: Bool
  let last: String?
  let lastAt: String?
  let agent: String?
  let agentId: String?
  let role: String?
  let draft: Bool?
  let checks: String?
  let decision: String?
  let mergeable: String?
  let comments: Int?

  var repo: String { String(key.split(separator: "#").first ?? "") }
  var number: String { String(key.split(separator: "#").last ?? "") }
  var repoName: String { String(repo.split(separator: "/").last ?? "") }
  var reviewing: Bool { role == "reviewer" }
  var ready: Bool { draft != true && checks == "passed" && decision == "APPROVED" && mergeable == "yes" }

  var id: String { key }
}

struct RunEntry: Decodable, Hashable, Identifiable {
  let key: String
  let title: String
  let url: String
  let outcome: String
  let rule: String?
  let at: String
  let needsYou: Bool

  var id: String { key }
}

struct Status: Decodable {
  let updatedAt: String
  let host: String
  let error: String?
  let pulls: [Pull]
  let runs: [RunEntry]?
}

struct ConfigFile: Decodable, Hashable, Identifiable {
  let path: String
  let exists: Bool

  var id: String { path }
  var name: String { URL(fileURLWithPath: path).lastPathComponent }
}

struct ConfigRule: Decodable, Identifiable {
  struct Named: Decodable { let name: String }

  let file: String
  let summary: String
  let rule: Named

  var id: String { "\(file)#\(rule.name)" }
  var fileName: String { URL(fileURLWithPath: file).lastPathComponent }
}

struct ConfigSnapshot: Decodable {
  let directory: String
  let machine: String
  let files: [ConfigFile]
  let rules: [ConfigRule]
  let error: String?
}

enum Freshness {
  case missing, stale, live

  static let staleAfter: TimeInterval = 5 * 60

  static func of(_ status: Status?, now: Date) -> Freshness {
    guard let status else { return .missing }
    guard let updated = parseDate(status.updatedAt) else { return .stale }
    return now.timeIntervalSince(updated) > staleAfter ? .stale : .live
  }
}

func parseDate(_ iso: String) -> Date? {
  let precise = ISO8601DateFormatter()
  precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = precise.date(from: iso) { return date }

  return ISO8601DateFormatter().date(from: iso)
}

func age(_ iso: String?, now: Date) -> String? {
  guard let iso, let date = parseDate(iso) else { return nil }
  let seconds = max(0, Int(now.timeIntervalSince(date)))
  if seconds < 60 { return "now" }
  if seconds < 3600 { return "\(seconds / 60)m" }
  if seconds < 86400 { return "\(seconds / 3600)h" }
  return "\(seconds / 86400)d"
}
