// swift-tools-version: 5.9
import PackageDescription

// UI に依存しない純粋なロジックだけを置くパッケージ。
// これにより macOS/Xcode が無い環境でもテストと検証が実行できる。
let package = Package(
    name: "VocabKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "VocabKit", targets: ["VocabKit"]),
    ],
    targets: [
        .target(name: "VocabKit"),

        // Python 参照実装が生成したテストベクタと突き合わせる CLI。
        .executableTarget(
            name: "VerifyNormalizer",
            dependencies: ["VocabKit"]
        ),
        .executableTarget(
            name: "VerifyScheduler",
            dependencies: ["VocabKit"]
        ),

        .testTarget(
            name: "VocabKitTests",
            dependencies: ["VocabKit"]
        ),
    ]
)
