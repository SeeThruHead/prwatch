import AppKit
import Foundation

enum Version {
  static func parts(_ version: String) -> [Int] {
    version.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").map { Int($0) ?? 0 }
  }

  static func isNewer(_ candidate: String, than current: String) -> Bool {
    let (a, b) = (parts(candidate), parts(current))
    let width = max(a.count, b.count)
    let padded = { (p: [Int]) in p + Array(repeating: 0, count: width - p.count) }
    return padded(b).lexicographicallyPrecedes(padded(a))
  }
}

struct Release: Decodable {
  struct Asset: Decodable {
    let name: String
    let browser_download_url: URL
  }

  let tag_name: String
  let assets: [Asset]

  var version: String { tag_name.trimmingCharacters(in: CharacterSet(charactersIn: "v")) }

  var zip: URL? { assets.first { $0.name == "prwatch-\(version)-macos-arm64.zip" }?.browser_download_url }
}

@MainActor
final class Updater: ObservableObject {
  @Published private(set) var available: String?
  @Published private(set) var updating = false
  private(set) var checked = false

  static let latest = URL(string: "https://api.github.com/repos/SeeThruHead/prwatch/releases/latest")!
  static let checkEvery: TimeInterval = 6 * 60 * 60

  let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
  private var zip: URL?
  private var timer: Timer?

  init() {
    Task { await check() }
    timer = Timer.scheduledTimer(withTimeInterval: Self.checkEvery, repeats: true) { [weak self] _ in
      Task { @MainActor in await self?.check() }
    }
  }

  func check() async {
    defer { checked = true }
    var request = URLRequest(url: Self.latest)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    guard let (data, _) = try? await URLSession.shared.data(for: request),
      let release = try? JSONDecoder().decode(Release.self, from: data),
      Version.isNewer(release.version, than: current),
      let zip = release.zip
    else { return }
    self.zip = zip
    available = release.version
  }

  func update() {
    guard let zip, !updating else { return }
    updating = true
    let script = FileManager.default.temporaryDirectory.appendingPathComponent("prwatch-update.sh")
    guard (try? Self.script.write(to: script, atomically: true, encoding: .utf8)) != nil else {
      updating = false
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
    process.arguments = [
      "/bin/sh", script.path,
      String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundleURL.path, zip.absoluteString,
    ]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else {
      updating = false
      return
    }
    NSApp.terminate(nil)
  }

  // Waits for the app to quit, installs the new version the way the app was installed (Homebrew owns
  // anything under its Cellar), and reopens it. A failed install reopens the app that was there.
  static let script = #"""
    #!/bin/sh
    pid="$1"; app="$2"; zip="$3"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    case "$app" in
      */Cellar/prwatch/*)
        prefix="${app%%/Cellar/*}"
        "$prefix/bin/brew" upgrade seethruhead/tap/prwatch
        exec open "$prefix/opt/prwatch/prwatch.app"
        ;;
    esac
    work="$(mktemp -d)"
    if curl -fsSL "$zip" -o "$work/prwatch.zip" \
      && ditto -x -k "$work/prwatch.zip" "$work/new" \
      && [ -d "$work/new/prwatch.app" ] \
      && mv "$app" "$work/old.app"; then
      if ditto "$work/new/prwatch.app" "$app"; then
        rm -rf "$work"
      else
        rm -rf "$app"
        mv "$work/old.app" "$app"
      fi
    fi
    exec open "$app"
    """#
}
