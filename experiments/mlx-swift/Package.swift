// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "FolioMLX",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.31.3"),
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.31.3"),
        .package(url: "https://github.com/huggingface/swift-huggingface", exact: "0.9.0"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.3.0"),
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", revision: "8d86630ade569728aaea3dc1a29fc44e2efa719b"),
    ],
    targets: [
        .executableTarget(
            name: "folio-mlx",
            dependencies: [
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
                .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "HuggingFace", package: "swift-huggingface"),
                .product(name: "Tokenizers", package: "swift-transformers"),
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
                .product(name: "MLXAudioSTT", package: "mlx-audio-swift"),
            ]
        ),
    ]
)
