// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PrwatchBar",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "PrwatchBar", path: "Sources/PrwatchBar")
  ]
)
