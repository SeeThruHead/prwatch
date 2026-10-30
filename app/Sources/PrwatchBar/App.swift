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
    let updater = Updater()
    let deadline = Date().addingTimeInterval(5)
    while !updater.checked && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }
    let view = NSHostingView(rootView: MenuContent(watch: Watch(), updater: updater).background(Color(nsColor: .windowBackgroundColor)))
    view.appearance = NSAppearance(named: .darkAqua)
    view.frame = NSRect(origin: .zero, size: view.fittingSize)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = view
    view.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    view.frame = NSRect(origin: .zero, size: view.fittingSize)
    window.setContentSize(view.frame.size)
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: file)
  }
}

@MainActor
final class StatusBarController: NSObject, NSApplicationDelegate, NSPopoverDelegate {
  private let watch = Watch()
  private let updater = Updater()
  private let popover = NSPopover()
  private lazy var anchor: NSWindow = {
    let window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.level = .statusBar
    window.collectionBehavior = [.canJoinAllSpaces, .stationary]
    return window
  }()
  private var item: NSStatusItem?
  private var subscription: AnyCancellable?
  private var closedAt = Date.distantPast

  // A transient popover closes on the mouse-down of a click on the status
  // item, then the button action fires on mouse-up and would reopen it.
  private var closedByThisClick: Bool {
    Date().timeIntervalSince(closedAt) < 0.3
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.target = self
    item.button?.action = #selector(toggle)
    item.button?.imagePosition = .imageLeading
    self.item = item

    let host = NSHostingController(rootView: MenuContent(watch: watch, updater: updater))
    host.sizingOptions = .preferredContentSize
    popover.contentViewController = host
    popover.behavior = .transient
    popover.animates = false
    popover.delegate = self

    subscription = watch.objectWillChange.merge(with: updater.objectWillChange).sink { [weak self] _ in
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
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "prwatch")
    button.image = updater.available == nil ? image : image.map(Self.markedForUpdate)
    button.title = waiting > 0 ? " \(waiting)" : ""
    button.toolTip = updater.available.map { "prwatch \($0) is available" }
  }

  // Stays a template image so the menu bar still tints it; the arrow sits in a gap cut out of the bell.
  private static func markedForUpdate(_ base: NSImage) -> NSImage {
    guard
      let mark = NSImage(systemSymbolName: "arrow.up.circle.fill", accessibilityDescription: "update available")?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 8, weight: .bold))
    else { return base }
    let size = NSSize(width: base.size.width + mark.size.width / 2, height: base.size.height)
    let image = NSImage(size: size, flipped: false) { _ in
      base.draw(in: NSRect(origin: .zero, size: base.size))
      let markRect = NSRect(x: size.width - mark.size.width, y: 0, width: mark.size.width, height: mark.size.height)
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(ovalIn: markRect.insetBy(dx: -1.5, dy: -1.5)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      mark.draw(in: markRect)
      return true
    }
    image.isTemplate = true
    return image
  }

  @objc private func toggle() {
    guard let button = item?.button else { return }
    if popover.isShown {
      popover.performClose(nil)
      return
    }
    if closedByThisClick { return }
    guard let buttonWindow = button.window else { return }
    watch.reload()
    anchor.setFrame(buttonWindow.convertToScreen(button.convert(button.bounds, to: nil)), display: false)
    anchor.orderFrontRegardless()
    guard let anchorView = anchor.contentView else { return }
    popover.show(relativeTo: anchorView.bounds, of: anchorView, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }

  func popoverDidClose(_ notification: Notification) {
    closedAt = Date()
    anchor.orderOut(nil)
  }
}

struct Pill: View {
  let symbol: String
  let color: Color
  var text: String? = nil
  var help: String
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
      if hovering {
        Text(help).font(.system(size: 11, weight: .semibold)).lineLimit(1).fixedSize()
      } else if let text {
        Text(text).font(.system(size: 11, weight: .semibold, design: .rounded))
      }
    }
    .foregroundStyle(color)
    .padding(.horizontal, 6).padding(.vertical, 2)
    .background(Capsule().fill(color.opacity(hovering ? 0.3 : 0.18)))
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

struct Pills: View {
  let pull: Pull

  var body: some View {
    HStack(spacing: 4) {
      if pull.ready {
        Pill(symbol: "arrow.triangle.merge", color: .green, help: "Ready to merge")
      }
      if pull.draft == true {
        Pill(symbol: "pencil", color: .gray, help: "Draft")
      }
      checks
      review
      if let comments = pull.comments, comments > 0 {
        Pill(symbol: "bubble.left.fill", color: .blue, text: "\(comments)", help: "\(comments) from people")
      }
    }
  }

  @ViewBuilder private var checks: some View {
    switch pull.checks {
    case "passed": Pill(symbol: "checkmark", color: .green, help: "CI passed")
    case "failed": Pill(symbol: "xmark", color: .red, help: "CI failed")
    case "pending": Pill(symbol: "clock", color: .orange, help: "CI running")
    default: EmptyView()
    }
  }

  @ViewBuilder private var review: some View {
    switch pull.decision {
    case "APPROVED": Pill(symbol: "hand.thumbsup.fill", color: .green, help: "Approved")
    case "CHANGES_REQUESTED": Pill(symbol: "exclamationmark.bubble.fill", color: .red, help: "Changes requested")
    case "REVIEW_REQUIRED": Pill(symbol: "eye", color: .gray, help: "Review required")
    default: EmptyView()
    }
  }
}

struct PullRow: View {
  @ObservedObject var watch: Watch
  let pull: Pull
  @State var expanded: Bool
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      summary
      if expanded { details.padding(.leading, 17) }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(hovering || expanded ? 0.07 : 0)))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
  }

  private var summary: some View {
    HStack(spacing: 8) {
      Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9)).foregroundStyle(.secondary).frame(width: 9)
      Circle().fill(pull.needsYou ? Color.orange : Color.clear).frame(width: 7, height: 7)
      if pull.reviewing {
        Pill(symbol: "eyeglasses", color: .blue, help: "Reviewing")
      }
      Text(pull.title).font(.system(size: 13, weight: pull.needsYou ? .semibold : .regular)).lineLimit(1)
      Spacer(minLength: 6)
      Pills(pull: pull)
      Text("#\(pull.number)")
        .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).fixedSize()
      Text(age(pull.lastAt, now: watch.now) ?? "")
        .font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary).frame(width: 30, alignment: .trailing)
    }
    .help(pull.key)
    .onTapGesture { expanded.toggle() }
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(pull.key).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
      if let last = pull.last {
        Text(last).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 6) {
        Button { watch.open(pull) } label: { Label("Open", systemImage: "safari") }
        Button { watch.check(pull) } label: { Label("Check comments", systemImage: "text.bubble") }
          .disabled(watch.checks[pull.key] == Watch.asking)
          .help("Ask the agent on this branch which review comments are resolved")
        if pull.agent == nil || watch.checks[pull.key] == Watch.noAgent {
          Button { watch.start(pull) } label: { Label("Start agent", systemImage: "play.circle") }
            .disabled(watch.checks[pull.key] == Watch.asking)
            .help("Start Claude in Orca to report which review comments are resolved")
        }
        if let agentId = pull.agentId, watch.status?.host == "herdr", !agentId.hasPrefix("claude:") {
          Button { watch.focus(pull) } label: { Label("Pane", systemImage: "terminal") }
        }
        if pull.needsYou {
          Button { watch.acknowledge(pull) } label: { Label("Seen", systemImage: "checkmark.circle") }
        }
        Spacer()
        Label(pull.agent ?? "no agent on this branch", systemImage: pull.agent == nil ? "person.crop.circle.badge.questionmark" : "cpu")
          .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
      }
      .buttonStyle(.bordered).controlSize(.small)
      if let checked = watch.checks[pull.key] {
        Text(checked).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
      }
    }
  }
}

struct PullSection: View {
  @ObservedObject var watch: Watch
  let title: String
  let symbol: String
  let color: Color
  let pulls: [Pull]
  @State var open: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 8) {
        Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9)).foregroundStyle(.secondary).frame(width: 9)
        Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(color)
        Text(title).font(.system(size: 12, weight: .bold))
        Text("\(pulls.count)")
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .padding(.horizontal, 6).padding(.vertical, 1)
          .background(Capsule().fill(color.opacity(0.2)))
        Spacer()
      }
      .padding(.horizontal, 8).padding(.vertical, 4)
      .contentShape(Rectangle())
      .onTapGesture { open.toggle() }
      if open {
        ForEach(pulls) { pull in
          PullRow(watch: watch, pull: pull, expanded: false).padding(.leading, 10)
        }
      }
    }
  }
}

struct Stat: View {
  let symbol: String
  let value: Int
  let color: Color
  let help: String
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: symbol).font(.system(size: 11))
      Text(hovering ? "\(value) \(help.lowercased())" : "\(value)").font(.system(size: 12, weight: .semibold, design: .rounded)).fixedSize()
    }
    .foregroundStyle(value > 0 ? color : Color.secondary)
    .onHover { hovering = $0 }
  }
}

struct MenuContent: View {
  @ObservedObject var watch: Watch
  @ObservedObject var updater: Updater
  @State private var listHeight: CGFloat = 0

  private var pulls: [Pull] { watch.status?.pulls ?? [] }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      if let error = watch.status?.error {
        Label(error, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
      Divider()
      if watch.waiting.isEmpty && watch.others.isEmpty {
        Label("All quiet", systemImage: "checkmark.seal").font(.system(size: 13)).foregroundStyle(.secondary)
      } else {
        list
      }
      Divider()
      footer
    }
    .padding(12)
    .frame(width: 600)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var header: some View {
    HStack(spacing: 14) {
      Image(systemName: watch.watcherRunning && watch.freshness == .live ? "bell.fill" : "bell.slash")
      Text("prwatch").font(.system(size: 14, weight: .bold))
      Text(updater.current).font(.system(size: 11)).foregroundStyle(.secondary)
      Spacer()
      Stat(symbol: "circle.fill", value: watch.waiting.count, color: .orange, help: "Need you")
      Stat(symbol: "arrow.triangle.merge", value: pulls.filter(\.ready).count, color: .green, help: "Ready to merge")
      Stat(symbol: "xmark.circle.fill", value: pulls.filter { $0.checks == "failed" }.count, color: .red, help: "CI failing")
      Stat(symbol: "eyeglasses", value: pulls.filter(\.reviewing).count, color: .blue, help: "Reviewing")
      Stat(symbol: "tray.full", value: pulls.count, color: .secondary, help: "Watching via \(watch.status?.host ?? "?")")
    }
  }

  private var footer: some View {
    HStack(spacing: 12) {
      Toggle("Open at login", isOn: Binding(get: { watch.openAtLogin }, set: { watch.setOpenAtLogin($0) }))
        .toggleStyle(.checkbox).font(.system(size: 11))
      if !watch.watcherRunning {
        Label("restarting watcher", systemImage: "arrow.clockwise").font(.system(size: 11)).foregroundStyle(.orange)
      }
      if watch.cliLocation == nil {
        Button("Install CLI") { watch.installCli() }.buttonStyle(.link).font(.system(size: 11))
      }
      Spacer()
      if let version = updater.available {
        Button("Update \(version)") { updater.update() }.disabled(updater.updating)
      }
      Button("Quit") { NSApp.terminate(nil) }
    }
  }

  private var maxListHeight: CGFloat {
    (NSScreen.main?.visibleFrame.height ?? 800) * 0.85
  }

  private var list: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        if !watch.waiting.isEmpty {
          PullSection(watch: watch, title: "Needs you", symbol: "circle.fill", color: .orange, pulls: watch.waiting, open: true)
        }
        if !watch.others.isEmpty {
          PullSection(watch: watch, title: "Other activity", symbol: "tray", color: .gray, pulls: watch.others, open: true)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { listHeight = $0 }
    }
    .frame(height: min(listHeight, maxListHeight))
  }
}
