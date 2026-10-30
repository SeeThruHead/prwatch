import AppKit
import Combine
import Foundation
import ServiceManagement

@MainActor
final class Watch: ObservableObject {
  @Published private(set) var status: Status?
  @Published private(set) var now = Date()
  @Published private(set) var watcherRunning = false
  @Published private(set) var cliLocation: String?
  @Published private(set) var checks: [String: String] = [:]
  @Published private(set) var openAtLogin = SMAppService.mainApp.status == .enabled

  private var timer: Timer?
  private var watcher: Process?
  private var stopping = false
  private let home: URL
  private let broadcaster = StateBroadcast("dev.seethruhead.prwatch")

  static let restartDelay: TimeInterval = 10

  init() {
    let environment = ProcessInfo.processInfo.environment
    home = environment["PRWATCH_HOME"].map { URL(fileURLWithPath: $0) }
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".prwatch")
    reload()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.reload() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.stopWatcher() }
    }
    signal(SIGTERM, SIG_IGN)
    termination.setEventHandler { NSApp.terminate(nil) }
    termination.resume()
  }

  private let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)

  var freshness: Freshness { Freshness.of(status, now: now) }

  var waiting: [Pull] { status?.pulls.filter(\.needsYou) ?? [] }

  var others: [Pull] { status?.pulls.filter { !$0.needsYou && $0.last != nil } ?? [] }

  var helper: String {
    let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/prwatch").path
    return FileManager.default.isExecutableFile(atPath: bundled) ? bundled : "prwatch"
  }

  static var cliLink: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/prwatch")
  }

  static let cliCandidates = ["/opt/homebrew/bin/prwatch", "/usr/local/bin/prwatch"]

  var cliInstalled: Bool { cliLocation != nil }

  private func installedCli() -> String? {
    let target = URL(fileURLWithPath: helper).resolvingSymlinksInPath().path
    return (Self.cliCandidates + [Self.cliLink.path]).first { candidate in
      FileManager.default.fileExists(atPath: candidate)
        && URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path == target
    }
  }

  func reload() {
    now = Date()
    cliLocation = installedCli()
    let file = home.appendingPathComponent("status.json")
    guard let data = try? Data(contentsOf: file) else {
      status = nil
      broadcast()
      return
    }
    status = try? JSONDecoder().decode(Status.self, from: data)
    broadcast()
  }

  private var stateName: String {
    guard let status else { return "off" }
    if status.error != nil { return "error" }
    if freshness == .stale { return "stale" }
    return waiting.isEmpty ? "ok" : "needs-you"
  }

  private func broadcast() {
    let pulls = status?.pulls ?? []
    broadcaster.publish([
      "state": stateName,
      "open": String(pulls.count),
      "needsYou": String(waiting.count),
      "failing": String(pulls.filter { $0.checks == "failed" }.count),
    ])
  }

  func startWatcher() {
    guard watcher == nil else { return }
    stopping = false
    let process = login("exec '\(helper)' run")
    process.terminationHandler = { [weak self] _ in
      Task { @MainActor in self?.watcherExited() }
    }
    do {
      try process.run()
      watcher = process
      watcherRunning = true
    } catch {
      watcherRunning = false
    }
  }

  func stopWatcher() {
    stopping = true
    watcher?.terminate()
    watcher = nil
    watcherRunning = false
  }

  private func watcherExited() {
    watcher = nil
    watcherRunning = false
    guard !stopping else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.restartDelay) { [weak self] in
      Task { @MainActor in self?.startWatcher() }
    }
  }

  func open(_ pull: Pull) {
    guard let url = URL(string: pull.url) else { return }
    NSWorkspace.shared.open(url)
  }

  func acknowledge(_ pull: Pull) {
    run("'\(helper)' ack '\(pull.key)'") { [weak self] in self?.reload() }
  }

  static let asking = "asking…"
  static let noAgent = "no agent on this branch"

  func check(_ pull: Pull) {
    report(pull.key, "check")
  }

  func start(_ pull: Pull) {
    report(pull.key, "start")
  }

  private func report(_ key: String, _ command: String) {
    checks[key] = Self.asking
    let process = login("'\(helper)' \(command) '\(key)' 2>&1")
    let output = Pipe()
    process.standardOutput = output
    process.terminationHandler = { [weak self] _ in
      let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      let last = text.split(whereSeparator: \.isNewline).last.map(String.init) ?? "could not ask"
      Task { @MainActor in self?.checks[key] = last }
    }
    do {
      try process.run()
    } catch {
      checks[key] = "could not ask"
    }
  }

  func focus(_ pull: Pull) {
    guard let agentId = pull.agentId, status?.host == "herdr", !agentId.hasPrefix("claude:") else { return }
    run("herdr agent focus '\(agentId)'")
  }

  func installCli() {
    let link = Self.cliLink
    try? FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: link)
    try? FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: helper)
    reload()
  }

  func setOpenAtLogin(_ enabled: Bool) {
    if enabled {
      try? SMAppService.mainApp.register()
    } else {
      try? SMAppService.mainApp.unregister()
    }
    openAtLogin = SMAppService.mainApp.status == .enabled
  }

  private func login(_ command: String) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
    process.arguments = ["-ilc", command]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    return process
  }

  private func run(_ command: String, then: (@MainActor () -> Void)? = nil) {
    let process = login(command)
    process.terminationHandler = { _ in
      Task { @MainActor in then?() }
    }
    try? process.run()
  }
}
