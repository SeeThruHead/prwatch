import AppKit
import Combine
import SwiftUI

@main
enum PrwatchBar {
  @MainActor private static let controller = StatusBarController()

  @MainActor static func main() {
    let arguments = CommandLine.arguments
    if let flag = arguments.firstIndex(of: "--snapshot"), flag + 1 < arguments.count {
      snapshot(to: URL(fileURLWithPath: arguments[flag + 1]))
      return
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.delegate = controller
    app.run()
  }

  @MainActor private static func snapshot(to file: URL) {
    let view = NSHostingView(rootView: MenuContent(watch: Watch()).background(Color(nsColor: .windowBackgroundColor)))
    view.appearance = NSAppearance(named: .darkAqua)
    view.frame = NSRect(origin: .zero, size: view.fittingSize)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = view
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: file)
  }
}

@MainActor
final class StatusBarController: NSObject, NSApplicationDelegate {
  private let watch = Watch()
  private let popover = NSPopover()
  private var item: NSStatusItem?
  private var subscription: AnyCancellable?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.target = self
    item.button?.action = #selector(toggle)
    item.button?.imagePosition = .imageLeading
    self.item = item

    let host = NSHostingController(rootView: MenuContent(watch: watch))
    host.sizingOptions = .preferredContentSize
    popover.contentViewController = host
    popover.behavior = .transient
    popover.animates = false

    subscription = watch.objectWillChange.sink { [weak self] _ in
      DispatchQueue.main.async { self?.refreshButton() }
    }
    refreshButton()
    watch.startWatcher()
  }

  func applicationWillTerminate(_ notification: Notification) {
    watch.stopWatcher()
  }

  private func refreshButton() {
    guard let button = item?.button else { return }
    let waiting = watch.waiting.count
    let symbol: String
    switch watch.freshness {
    case .missing, .stale: symbol = "bell.slash"
    case .live: symbol = waiting > 0 ? "bell.badge.fill" : "bell"
    }
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "prwatch")
    button.title = waiting > 0 ? " \(waiting)" : ""
  }

  @objc private func toggle() {
    guard let button = item?.button else { return }
    if popover.isShown {
      popover.performClose(nil)
      return
    }
    watch.reload()
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }
}

struct PullRow: View {
  @ObservedObject var watch: Watch
  let pull: Pull

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Circle().fill(pull.needsYou ? Color.orange : Color.gray.opacity(0.5)).frame(width: 7, height: 7)
        Text(pull.key).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
        Spacer()
        if let when = relative(pull.lastAt, now: watch.now) {
          Text(when).font(.system(size: 11)).foregroundStyle(.secondary)
        }
      }
      Text(pull.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
      if let last = pull.last {
        Text(last).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
      }
      HStack(spacing: 10) {
        Button("Open") { watch.open(pull) }.buttonStyle(.link)
        if pull.agentId != nil, watch.status?.host == "herdr" {
          Button("Go to pane") { watch.focus(pull) }.buttonStyle(.link)
        }
        if pull.needsYou {
          Button("Seen") { watch.acknowledge(pull) }.buttonStyle(.link)
        }
        Spacer()
        if let agent = pull.agent {
          Text(agent).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
        }
      }
      .font(.system(size: 11))
    }
    .padding(.vertical, 4)
  }
}

struct MenuContent: View {
  @ObservedObject var watch: Watch

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      if let error = watch.status?.error {
        Text(error).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
      }
      if watch.waiting.isEmpty && watch.others.isEmpty {
        Text("Nothing new on your pull requests.").font(.system(size: 12)).foregroundStyle(.secondary)
      }
      if !watch.waiting.isEmpty {
        section("Needs you", watch.waiting)
      }
      if !watch.others.isEmpty {
        section("Handled by agents", watch.others)
      }
      Divider()
      footer
    }
    .padding(12)
    .frame(width: 380)
  }

  private var header: some View {
    HStack {
      Text("prwatch").font(.system(size: 13, weight: .semibold))
      Spacer()
      Text(headline).font(.system(size: 11)).foregroundStyle(.secondary)
    }
  }

  private var headline: String {
    if !watch.watcherRunning { return "watcher stopped, restarting…" }
    switch watch.freshness {
    case .live: return "watching \(watch.status?.pulls.count ?? 0) PRs via \(watch.status?.host ?? "?")"
    case .stale, .missing: return "checking…"
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      Toggle("Open at login", isOn: Binding(get: { watch.openAtLogin }, set: { watch.setOpenAtLogin($0) }))
        .toggleStyle(.checkbox).font(.system(size: 11))
      HStack {
        if watch.cliInstalled {
          Text("prwatch command in ~/.local/bin").font(.system(size: 11)).foregroundStyle(.secondary)
        } else {
          Button("Install command line tool") { watch.installCli() }.buttonStyle(.link).font(.system(size: 11))
        }
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.link).font(.system(size: 11))
      }
    }
  }

  private func section(_ title: String, _ pulls: [Pull]) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(pulls) { pull in
            PullRow(watch: watch, pull: pull)
            Divider()
          }
        }
      }
      .frame(maxHeight: 320)
    }
  }
}
