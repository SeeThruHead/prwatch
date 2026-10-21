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

  var id: String { key }
}

struct Status: Decodable {
  let updatedAt: String
  let host: String
  let error: String?
  let pulls: [Pull]
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
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: iso)
}

func relative(_ iso: String?, now: Date) -> String? {
  guard let iso, let date = parseDate(iso) else { return nil }
  let seconds = Int(now.timeIntervalSince(date))
  if seconds < 60 { return "just now" }
  if seconds < 3600 { return "\(seconds / 60)m ago" }
  if seconds < 86400 { return "\(seconds / 3600)h ago" }
  return "\(seconds / 86400)d ago"
}
