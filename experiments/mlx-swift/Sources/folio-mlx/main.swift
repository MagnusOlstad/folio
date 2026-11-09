import Darwin
import Foundation
import FolioMLXAudio
import MLX
import MLXEmbedders
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import MLXVLM
import HuggingFace
import Tokenizers
import MLXAudioCore
import MLXAudioSTT
import MLXAudioVAD
import FolioMLXProgress

private enum TaskKind: String { case generation, embedding, transcription, diarization, ocr }

private let ocrDefaultMaxTokens = 4096
// LightOnOCR was trained on ~1540px page renders, so small screenshots must be upscaled (and large
// ones scaled down) so the longest side is exactly this many pixels; the resize preserves aspect ratio.
private let ocrLongestEdge: CGFloat = 1540

private struct Message: Decodable {
    let role: String
    let content: String
}

private struct Request: Decodable {
    let id: String?
    let operation: String?
    let messages: [Message]?
    let input: [String]?
    let maxTokens: Int?
    let temperature: Float?
    let noThinking: Bool?
    let audioPath: String?
    let imagePath: String?
    let prompt: String?
}

private struct MemoryStatus: Encodable {
    let activeBytes: Int
    let cacheBytes: Int
    let peakResidentBytes: UInt64?
}

/// One Whisper segment. Times are seconds from the start of the audio file.
private struct TranscriptSegment: Encodable {
    let start: Double
    let end: Double
    let text: String
}

/// One Sortformer speaker turn. `speaker` is the model's 0-based speaker slot (at most 4).
private struct SpeakerSegment: Encodable {
    let start: Double
    let end: Double
    let speaker: Int
}

private struct Response: Encodable {
    let id: String?
    let model: String
    let text: String?
    let embeddings: [[Float]]?
    let state: String?
    let memory: MemoryStatus
    let metrics: Metrics?
    // Optional extras default to nil and are omitted from the JSON when absent.
    var segments: [TranscriptSegment]? = nil
    var speakerSegments: [SpeakerSegment]? = nil
}

private struct ReadyResponse: Encodable {
    let event = "ready"
    let model: String
    let task: String
    let modelDirectory: String?
    let memory: MemoryStatus
}

private struct DownloadProgressResponse: Encodable {
    let event = "download-progress"
    let scope: String
    let complete: Bool
    let downloadedBytes: Int64
    let totalBytes: Int64
}

private struct TranscriptionProgressResponse: Encodable {
    let event = "transcription-progress"
    let id: String?
    let percent: Int
}

private struct ErrorResponse: Encodable {
    let id: String?
    let error: String
    let memory: MemoryStatus
}

private struct Metrics: Encodable {
    let coldLoadSeconds: Double
    let totalRequestSeconds: Double
    let sessionReleaseSeconds: Double
    let cleanupSeconds: Double
    let ttftSeconds: Double?
    let promptTokens: Int?
    let generatedTokens: Int?
    let promptSeconds: Double?
    let generationSeconds: Double?
    let tokensPerSecond: Double?
    let requestPeakActiveBytes: Int
}

private struct GenerationOutput {
    let text: String
    let elapsedSeconds: Double
    let sessionReleaseSeconds: Double
    let ttftSeconds: Double?
    let promptTokens: Int?
    let generatedTokens: Int?
    let promptSeconds: Double?
    let generationSeconds: Double?
    let tokensPerSecond: Double?
    let requestPeakActiveBytes: Int
}

private func log(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func writeLine<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { return }
    FileHandle.standardOutput.write(data + Data([0x0a]))
}

private func writeDownloadProgress(_ progress: Progress, scope: String = "model") {
    guard let downloadedBytes = DownloadProgressBytes.downloadedBytes(for: progress) else { return }
    // HubClient emits a synthetic 1/1 value for a cached snapshot; file sizes
    // from the completed stage below provide the real cached-byte count.
    guard progress.totalUnitCount > 1 else { return }
    writeLine(DownloadProgressResponse(scope: scope, complete: false,
                                      downloadedBytes: downloadedBytes,
                                      totalBytes: progress.totalUnitCount))
}

private func writeDownloadStageCompletion(scope: String, directory: URL, files: [String]) {
    let downloadedBytes = files.reduce(Int64(0)) { total, filename in
        let file = directory.appendingPathComponent(filename).resolvingSymlinksInPath()
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = attributes[.size] as? NSNumber else { return total }
        return total + size.int64Value
    }
    guard downloadedBytes > 0 else { return }
    writeLine(DownloadProgressResponse(scope: scope, complete: true,
                                      downloadedBytes: downloadedBytes,
                                      totalBytes: downloadedBytes))
}

private struct WhisperVariant {
    let modelID: String
    let revision: String
    let tokenizerModelID: String
    let tokenizerRevision: String
    let modelFiles: [String]

    static let turbo = WhisperVariant(
        modelID: "mlx-community/whisper-large-v3-turbo",
        revision: "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
        tokenizerModelID: "openai/whisper-large-v3-turbo",
        tokenizerRevision: "876622f22dcb70921aea42327501f41c5f7f3354",
        modelFiles: ["config.json", "weights.safetensors"])

    static let large = WhisperVariant(
        modelID: "mlx-community/whisper-large-v3-asr-fp16",
        revision: "f4b9d561e7f1a5c0587726ff7ff03da2cc80fcf9",
        tokenizerModelID: "mlx-community/whisper-large-v3-asr-fp16",
        tokenizerRevision: "f4b9d561e7f1a5c0587726ff7ff03da2cc80fcf9",
        modelFiles: ["config.json", "model.safetensors"] + whisperTokenizerFiles)

    static let supported = [turbo, large]

    static func resolve(modelID: String, revision: String) -> WhisperVariant? {
        supported.first { $0.modelID == modelID && $0.revision == revision }
    }
}

private let whisperTokenizerFiles = [
    "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
    "added_tokens.json", "vocab.json", "merges.txt", "normalizer.json",
    "generation_config.json",
]

/// Sortformer speaker diarization (separate, optional download).
private struct SortformerVariant {
    let modelID: String
    let revision: String
    let modelFiles: [String]

    static let v21 = SortformerVariant(
        modelID: "mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16",
        revision: "e23e6404bd9859e93edbf94a740eb1c7fc58f12e",
        modelFiles: ["config.json", "model.safetensors"])

    static func resolve(modelID: String, revision: String) -> SortformerVariant? {
        v21.modelID == modelID && v21.revision == revision ? v21 : nil
    }
}

private func modelRepository(_ id: String) throws -> Repo.ID {
    guard let repository = Repo.ID(rawValue: id) else {
        throw NSError(domain: "FolioMLX", code: 20,
                      userInfo: [NSLocalizedDescriptionKey: "invalid Hugging Face model id: \(id)"])
    }
    return repository
}

private func localHubCache() -> HubCache {
    if let cachePath = ProcessInfo.processInfo.environment["HF_HUB_CACHE"], !cachePath.isEmpty {
        return HubCache(cacheDirectory: URL(fileURLWithPath: cachePath, isDirectory: true))
    }
    return .default
}

private func isNonEmptyFile(_ url: URL) -> Bool {
    let target = url.resolvingSymlinksInPath()
    guard let values = try? target.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]) else { return false }
    return values.isRegularFile == true && (values.fileSize ?? 0) > 0
}

private func validateWhisperSnapshot(_ directory: URL, variant: WhisperVariant) throws {
    let required = variant.modelFiles + whisperTokenizerFiles
    let missing = required.filter { !isNonEmptyFile(directory.appendingPathComponent($0)) }
    guard missing.isEmpty else {
        throw NSError(domain: "FolioMLX", code: 21,
                      userInfo: [NSLocalizedDescriptionKey:
                        "The installed Whisper snapshot is incomplete; missing: \(missing.joined(separator: ", "))"])
    }
}

private func installWhisperSnapshot(_ variant: WhisperVariant) async throws -> URL {
    let cache = localHubCache()
    let client = HubClient(cache: cache)
    let modelRepo = try modelRepository(variant.modelID)

    let modelDirectory = try await client.downloadSnapshot(
        of: modelRepo, revision: variant.revision, matching: variant.modelFiles,
        progressHandler: { progress in writeDownloadProgress(progress, scope: "model") })
    writeDownloadStageCompletion(scope: "model", directory: modelDirectory, files: variant.modelFiles)
    let expectedModelDirectory = try cache.snapshotPath(repo: modelRepo, kind: .model, commitHash: variant.revision)
    guard modelDirectory.standardizedFileURL == expectedModelDirectory.standardizedFileURL else {
        throw NSError(domain: "FolioMLX", code: 24,
                      userInfo: [NSLocalizedDescriptionKey: "HubClient returned an unexpected Whisper snapshot path"])
    }

    let tokenizerDirectory: URL
    if variant.tokenizerModelID == variant.modelID && variant.tokenizerRevision == variant.revision {
        tokenizerDirectory = modelDirectory
    } else {
        let tokenizerRepo = try modelRepository(variant.tokenizerModelID)
        tokenizerDirectory = try await client.downloadSnapshot(
            of: tokenizerRepo,
            revision: variant.tokenizerRevision,
            matching: whisperTokenizerFiles,
            progressHandler: { progress in writeDownloadProgress(progress, scope: "tokenizer") })
        writeDownloadStageCompletion(scope: "tokenizer", directory: tokenizerDirectory, files: whisperTokenizerFiles)
        let expectedTokenizerDirectory = try cache.snapshotPath(
            repo: tokenizerRepo, kind: .model, commitHash: variant.tokenizerRevision)
        guard tokenizerDirectory.standardizedFileURL == expectedTokenizerDirectory.standardizedFileURL else {
            throw NSError(domain: "FolioMLX", code: 24,
                          userInfo: [NSLocalizedDescriptionKey: "HubClient returned an unexpected Whisper tokenizer snapshot path"])
        }
    }

    for name in whisperTokenizerFiles {
        let source = tokenizerDirectory.appendingPathComponent(name)
        let destination = modelDirectory.appendingPathComponent(name)
        if !isNonEmptyFile(destination) {
            guard isNonEmptyFile(source) else {
                throw NSError(domain: "FolioMLX", code: 23,
                              userInfo: [NSLocalizedDescriptionKey: "The pinned Whisper tokenizer snapshot is missing \(name)"])
            }
            try FileManager.default.copyItem(at: source.resolvingSymlinksInPath(), to: destination)
        }
    }
    try validateWhisperSnapshot(modelDirectory, variant: variant)
    return modelDirectory
}

private func validateSortformerSnapshot(_ directory: URL, variant: SortformerVariant) throws {
    let missing = variant.modelFiles.filter { !isNonEmptyFile(directory.appendingPathComponent($0)) }
    guard missing.isEmpty else {
        throw NSError(domain: "FolioMLX", code: 31,
                      userInfo: [NSLocalizedDescriptionKey:
                        "The installed Sortformer snapshot is incomplete; missing: \(missing.joined(separator: ", "))"])
    }
}

private func installSortformerSnapshot(_ variant: SortformerVariant) async throws -> URL {
    let cache = localHubCache()
    let client = HubClient(cache: cache)
    let repo = try modelRepository(variant.modelID)
    let directory = try await client.downloadSnapshot(
        of: repo, revision: variant.revision, matching: variant.modelFiles,
        progressHandler: { progress in writeDownloadProgress(progress, scope: "model") })
    writeDownloadStageCompletion(scope: "model", directory: directory, files: variant.modelFiles)
    let expected = try cache.snapshotPath(repo: repo, kind: .model, commitHash: variant.revision)
    guard directory.standardizedFileURL == expected.standardizedFileURL else {
        throw NSError(domain: "FolioMLX", code: 33,
                      userInfo: [NSLocalizedDescriptionKey: "HubClient returned an unexpected Sortformer snapshot path"])
    }
    try validateSortformerSnapshot(directory, variant: variant)
    return directory
}

private func memoryStatus() -> MemoryStatus {
    let memory = Memory.snapshot()
    var usage = rusage()
    let resident = getrusage(RUSAGE_SELF, &usage) == 0 && usage.ru_maxrss >= 0
        ? UInt64(usage.ru_maxrss) : nil
    return MemoryStatus(activeBytes: memory.activeMemory, cacheBytes: memory.cacheMemory,
                        peakResidentBytes: resident)
}

private func seconds(from start: ContinuousClock.Instant, to end: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: end).components
    return Double(duration.seconds) + Double(duration.attoseconds) / 1_000_000_000_000_000_000
}

@main
private struct FolioMLX {
    static func main() async throws {
        var arguments = Array(CommandLine.arguments.dropFirst())
        var task = TaskKind.generation
        var modelID = "mlx-community/gemma-4-e4b-it-4bit"
        var revision = "475b9088d29754a3379866cf5aeb6b41acd313c2"
        var modelWasProvided = false
        var revisionWasProvided = false
        var modelDirectory: URL?
        var operation: String?
        var maxTokens = 512
        var maxTokensWasProvided = false
        var temperature: Float = 0.1
        while !arguments.isEmpty {
            let option = arguments.removeFirst()
            guard !arguments.isEmpty else { throw NSError(domain: "FolioMLX", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing value for \(option)"]) }
            let value = arguments.removeFirst()
            switch option {
            case "--task":
                guard let parsed = TaskKind(rawValue: value) else { throw NSError(domain: "FolioMLX", code: 2, userInfo: [NSLocalizedDescriptionKey: "task must be generation, embedding, transcription, diarization, or ocr"]) }
                task = parsed
            case "--model": modelID = value; modelWasProvided = true
            case "--revision": revision = value; revisionWasProvided = true
            case "--model-directory": modelDirectory = URL(fileURLWithPath: value, isDirectory: true)
            case "--operation": operation = value
            case "--max-tokens":
                guard let parsed = Int(value), parsed > 0 else { throw NSError(domain: "FolioMLX", code: 3, userInfo: [NSLocalizedDescriptionKey: "max tokens must be positive"]) }
                maxTokens = parsed
                maxTokensWasProvided = true
            case "--temperature":
                guard let parsed = Float(value), parsed.isFinite, parsed >= 0 else { throw NSError(domain: "FolioMLX", code: 4, userInfo: [NSLocalizedDescriptionKey: "temperature must be finite and non-negative"]) }
                temperature = parsed
            default: throw NSError(domain: "FolioMLX", code: 5, userInfo: [NSLocalizedDescriptionKey: "unknown option \(option)"])
            }
        }

        var whisperVariant: WhisperVariant?
        var sortformerVariant: SortformerVariant?
        if task == .transcription {
            if !modelWasProvided && !revisionWasProvided {
                modelID = WhisperVariant.turbo.modelID
                revision = WhisperVariant.turbo.revision
            } else if modelWasProvided && !revisionWasProvided,
                      let variant = WhisperVariant.supported.first(where: { $0.modelID == modelID }) {
                revision = variant.revision
            } else if !modelWasProvided {
                modelID = WhisperVariant.turbo.modelID
            }
            guard let variant = WhisperVariant.resolve(modelID: modelID, revision: revision) else {
                throw NSError(domain: "FolioMLX", code: 6,
                              userInfo: [NSLocalizedDescriptionKey: "transcription requires one supported pinned Whisper model and revision pair"])
            }
            whisperVariant = variant
            guard operation == "install" || operation == "transcribe" else {
                throw NSError(domain: "FolioMLX", code: 7,
                              userInfo: [NSLocalizedDescriptionKey: "transcription requires --operation install or --operation transcribe"])
            }
            if operation == "transcribe", modelDirectory == nil {
                throw NSError(domain: "FolioMLX", code: 8,
                              userInfo: [NSLocalizedDescriptionKey: "transcription requires a fully installed local --model-directory"])
            }
            if operation == "transcribe", let modelDirectory {
                let cache = localHubCache()
                let repository = try modelRepository(variant.modelID)
                let expected = try cache.snapshotPath(repo: repository, kind: .model, commitHash: variant.revision)
                guard modelDirectory.standardizedFileURL == expected.standardizedFileURL else {
                    throw NSError(domain: "FolioMLX", code: 25,
                                  userInfo: [NSLocalizedDescriptionKey: "transcription must load from the matching pinned HF_HUB_CACHE snapshot"])
                }
                try validateWhisperSnapshot(modelDirectory, variant: variant)
            }
        } else if task == .diarization {
            guard let variant = SortformerVariant.resolve(modelID: modelID, revision: revision) else {
                throw NSError(domain: "FolioMLX", code: 6,
                              userInfo: [NSLocalizedDescriptionKey: "diarization requires the supported pinned Sortformer model and revision pair"])
            }
            sortformerVariant = variant
            guard operation == "install" || operation == "diarize" else {
                throw NSError(domain: "FolioMLX", code: 7,
                              userInfo: [NSLocalizedDescriptionKey: "diarization requires --operation install or --operation diarize"])
            }
            if operation == "diarize" {
                guard let modelDirectory else {
                    throw NSError(domain: "FolioMLX", code: 8,
                                  userInfo: [NSLocalizedDescriptionKey: "diarization requires a fully installed local --model-directory"])
                }
                let cache = localHubCache()
                let repository = try modelRepository(variant.modelID)
                let expected = try cache.snapshotPath(repo: repository, kind: .model, commitHash: variant.revision)
                guard modelDirectory.standardizedFileURL == expected.standardizedFileURL else {
                    throw NSError(domain: "FolioMLX", code: 25,
                                  userInfo: [NSLocalizedDescriptionKey: "diarization must load from the matching pinned HF_HUB_CACHE snapshot"])
                }
                try validateSortformerSnapshot(modelDirectory, variant: variant)
            }
        } else if operation != nil {
            throw NSError(domain: "FolioMLX", code: 9,
                          userInfo: [NSLocalizedDescriptionKey: "--operation is only supported with --task transcription or --task diarization"])
        }

        if task == .transcription, operation == "install" {
            guard let whisperVariant else { fatalError("validated transcription variant was not provided") }
            let modelDirectory = try await installWhisperSnapshot(whisperVariant)
            writeLine(ReadyResponse(model: modelID, task: task.rawValue,
                                    modelDirectory: modelDirectory.path, memory: memoryStatus()))
            return
        }

        if task == .diarization, operation == "install" {
            guard let sortformerVariant else { fatalError("validated diarization variant was not provided") }
            let modelDirectory = try await installSortformerSnapshot(sortformerVariant)
            writeLine(ReadyResponse(model: modelID, task: task.rawValue,
                                    modelDirectory: modelDirectory.path, memory: memoryStatus()))
            return
        }

        let clock = ContinuousClock()
        let processStarted = clock.now
        let generator: ModelContainer?
        let embedder: EmbedderModelContainer?
        let whisper: WhisperModel?
        var sortformer: SortformerModel?
        if task == .generation || task == .ocr {
            log("Loading \(task == .ocr ? "OCR" : "generation") model \(modelID)…")
            // Pick the factory explicitly: linking MLXVLM adds its factory to the global
            // registry, which must not change how generation checkpoints are loaded.
            if let modelDirectory {
                if task == .ocr {
                    generator = try await VLMModelFactory.shared.loadContainer(
                        from: modelDirectory, using: #huggingFaceTokenizerLoader())
                } else {
                    generator = try await LLMModelFactory.shared.loadContainer(
                        from: modelDirectory, using: #huggingFaceTokenizerLoader())
                }
            } else if task == .ocr {
                generator = try await VLMModelFactory.shared.loadContainer(
                    from: #hubDownloader(), using: #huggingFaceTokenizerLoader(),
                    configuration: ModelConfiguration(id: modelID, revision: revision),
                    progressHandler: { progress in writeDownloadProgress(progress) })
            } else {
                let configuration = ModelConfiguration(id: modelID, revision: revision,
                    extraEOSTokens: Set(stopTokens(for: modelID)))
                generator = try await LLMModelFactory.shared.loadContainer(
                    from: #hubDownloader(), using: #huggingFaceTokenizerLoader(),
                    configuration: configuration,
                    progressHandler: { progress in writeDownloadProgress(progress) })
            }
            embedder = nil
            whisper = nil
        } else {
            if task == .transcription {
                log("Loading transcription model \(modelID)…")
                guard let modelDirectory else { fatalError("validated transcription snapshot was not provided") }
                guard let whisperVariant else { fatalError("validated transcription variant was not provided") }
                try validateWhisperSnapshot(modelDirectory, variant: whisperVariant)
                let loadedWhisper = try await WhisperModel.fromDirectory(modelDirectory, cache: localHubCache())
                // Folio needs real segment times, so enable timestamp tokens (see the pinned Whisper patch).
                loadedWhisper.timestampsEnabled = true
                whisper = loadedWhisper
                generator = nil
                embedder = nil
            } else if task == .diarization {
                log("Loading diarization model \(modelID)…")
                guard let modelDirectory else { fatalError("validated diarization snapshot was not provided") }
                guard let sortformerVariant else { fatalError("validated diarization variant was not provided") }
                try validateSortformerSnapshot(modelDirectory, variant: sortformerVariant)
                sortformer = try SortformerModel.fromModelDirectory(modelDirectory)
                generator = nil
                embedder = nil
                whisper = nil
            } else {
                log("Loading embedding model \(modelID)…")
                if let modelDirectory {
                    embedder = try await EmbedderModelFactory.shared.loadContainer(
                        from: modelDirectory, using: #huggingFaceTokenizerLoader())
                } else {
                    embedder = try await EmbedderModelFactory.shared.loadContainer(
                        from: #hubDownloader(), using: #huggingFaceTokenizerLoader(),
                        configuration: ModelConfiguration(id: modelID, revision: revision),
                        progressHandler: { progress in writeDownloadProgress(progress) })
                }
                generator = nil
                whisper = nil
            }
        }
        let coldLoadSeconds = seconds(from: processStarted, to: clock.now)
        synchronizeDefaultStream()
        Memory.clearCache()
        synchronizeDefaultStream()
        log("Model ready. Reading JSONL requests from stdin.")
        writeLine(ReadyResponse(model: modelID, task: task.rawValue,
                                modelDirectory: modelDirectory?.path, memory: memoryStatus()))

        while let line = readLine() {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let started = clock.now
            var requestID: String?
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                requestID = request.id
                switch request.operation ?? (task == .generation ? "generate" : (task == .embedding ? "embed" : (task == .ocr ? "ocr" : (task == .diarization ? "diarize" : "transcribe")))) {
                case "status":
                    writeLine(Response(id: requestID, model: modelID, text: nil, embeddings: nil,
                                       state: "loaded", memory: memoryStatus(), metrics: nil))
                case "shutdown":
                    writeLine(Response(id: requestID, model: modelID, text: nil, embeddings: nil,
                                       state: "stopped", memory: memoryStatus(), metrics: nil))
                    return
                case "generate":
                    guard task == .generation, let generator else { throw modelTaskError("generation") }
                    let messages = request.messages ?? []
                    guard messages.count == 2, messages[0].role == "system", messages[1].role == "user",
                          !messages[0].content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          !messages[1].content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        throw NSError(domain: "FolioMLX", code: 10, userInfo: [NSLocalizedDescriptionKey: "messages must contain a non-empty system message followed by a non-empty user message"])
                    }
                    let requestTokens = request.maxTokens ?? maxTokens
                    let requestTemperature = request.temperature ?? temperature
                    guard requestTokens > 0, requestTemperature.isFinite, requestTemperature >= 0 else {
                        throw NSError(domain: "FolioMLX", code: 11, userInfo: [NSLocalizedDescriptionKey: "generation parameters are invalid"])
                    }
                    Memory.peakMemory = 0
                    let generated = try await generate(
                        model: generator, system: messages[0].content, prompt: messages[1].content,
                        parameters: GenerateParameters(maxTokens: requestTokens, temperature: requestTemperature),
                        noThinking: request.noThinking != false, clock: clock)
                    writeLine(generationResponse(id: requestID, model: modelID, generated: generated,
                                                 coldLoadSeconds: coldLoadSeconds, clock: clock))
                case "ocr":
                    guard task == .ocr, let generator else { throw modelTaskError("ocr") }
                    guard let imagePath = request.imagePath, !imagePath.isEmpty else {
                        throw NSError(domain: "FolioMLX", code: 16, userInfo: [NSLocalizedDescriptionKey: "imagePath must name a local image file"])
                    }
                    let imageURL = URL(fileURLWithPath: imagePath)
                    var isDirectory: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: imageURL.path, isDirectory: &isDirectory),
                          !isDirectory.boolValue else {
                        throw NSError(domain: "FolioMLX", code: 17, userInfo: [NSLocalizedDescriptionKey: "The selected image file is no longer available."])
                    }
                    let requestTokens = request.maxTokens ?? (maxTokensWasProvided ? maxTokens : ocrDefaultMaxTokens)
                    guard requestTokens > 0 else {
                        throw NSError(domain: "FolioMLX", code: 11, userInfo: [NSLocalizedDescriptionKey: "generation parameters are invalid"])
                    }
                    Memory.peakMemory = 0
                    // Longest edge scaled to ocrLongestEdge (not the 512x512 session resize), greedy
                    // decoding, and an empty user text unless the caller supplies one: LightOnOCR transcribes to Markdown.
                    let generated = try await generate(
                        model: generator, system: nil, prompt: request.prompt ?? "",
                        images: [.url(imageURL)],
                        processing: UserInput.Processing(resize: CGSize(width: ocrLongestEdge, height: ocrLongestEdge)),
                        parameters: GenerateParameters(maxTokens: requestTokens, temperature: 0),
                        noThinking: false, clock: clock)
                    writeLine(generationResponse(id: requestID, model: modelID, generated: generated,
                                                 coldLoadSeconds: coldLoadSeconds, clock: clock))
                case "embed":
                    guard task == .embedding, let embedder else { throw modelTaskError("embedding") }
                    guard let input = request.input, !input.isEmpty,
                          input.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                        throw NSError(domain: "FolioMLX", code: 12, userInfo: [NSLocalizedDescriptionKey: "input must contain non-empty strings"])
                    }
                    Memory.peakMemory = 0
                    let vectors = try await embed(input, using: embedder)
                    synchronizeDefaultStream()
                    Memory.clearCache()
                    synchronizeDefaultStream()
                    writeLine(Response(id: requestID, model: modelID, text: nil, embeddings: vectors,
                                       state: nil, memory: memoryStatus(), metrics: nil))
                case "transcribe":
                    guard task == .transcription, let whisper else { throw modelTaskError("transcription") }
                    guard let audioPath = request.audioPath, !audioPath.isEmpty else {
                        throw NSError(domain: "FolioMLX", code: 14, userInfo: [NSLocalizedDescriptionKey: "audioPath must name a local audio file"])
                    }
                    let audioURL = URL(fileURLWithPath: audioPath)
                    guard FileManager.default.fileExists(atPath: audioURL.path) else {
                        throw NSError(domain: "FolioMLX", code: 15, userInfo: [NSLocalizedDescriptionKey: "The selected audio file is no longer available."])
                    }
                    let output = try transcribeAudio(whisper, from: audioURL, requestID: requestID)
                    synchronizeDefaultStream()
                    Memory.clearCache()
                    synchronizeDefaultStream()
                    writeLine(Response(id: requestID, model: modelID, text: output.text,
                                       embeddings: nil, state: nil, memory: memoryStatus(), metrics: nil,
                                       segments: output.segments))
                case "diarize":
                    guard task == .diarization, let sortformer else { throw modelTaskError("diarization") }
                    guard let audioPath = request.audioPath, !audioPath.isEmpty else {
                        throw NSError(domain: "FolioMLX", code: 14, userInfo: [NSLocalizedDescriptionKey: "audioPath must name a local audio file"])
                    }
                    let audioURL = URL(fileURLWithPath: audioPath)
                    guard FileManager.default.fileExists(atPath: audioURL.path) else {
                        throw NSError(domain: "FolioMLX", code: 15, userInfo: [NSLocalizedDescriptionKey: "The selected audio file is no longer available."])
                    }
                    Memory.peakMemory = 0
                    let speakerSegments = try await diarizeAudio(sortformer, from: audioURL, requestID: requestID)
                    synchronizeDefaultStream()
                    Memory.clearCache()
                    synchronizeDefaultStream()
                    writeLine(Response(id: requestID, model: modelID, text: nil,
                                       embeddings: nil, state: nil, memory: memoryStatus(), metrics: nil,
                                       speakerSegments: speakerSegments))
                default:
                    throw NSError(domain: "FolioMLX", code: 13, userInfo: [NSLocalizedDescriptionKey: "unknown operation"])
                }
            } catch {
                synchronizeDefaultStream()
                Memory.clearCache()
                synchronizeDefaultStream()
                writeLine(ErrorResponse(id: requestID, error: error.localizedDescription, memory: memoryStatus()))
            }
            _ = seconds(from: started, to: clock.now)
        }
    }
}

private func transcribeAudio(_ whisper: WhisperModel, from url: URL, requestID: String?) throws
    -> (text: String, segments: [TranscriptSegment]) {
    let reader = try AudioWindowReader(url: url)
    var transcriptParts: [String] = []
    var segments: [TranscriptSegment] = []
    while true {
        // Each window is transcribed independently, so segment times are offset by where it starts.
        let windowStart = Double(reader.completedFrames) / Double(reader.sampleRate)
        guard let window = try reader.nextWindow() else { break }
        let part = try autoreleasepool { () throws -> (text: String, segments: [TranscriptSegment]) in
            let samples = try resampleAudio(window.samples, from: reader.sampleRate, to: 16_000)
            let audio = MLXArray(samples)
            let output = whisper.generate(audio: audio)
            let windowSegments = (output.segments ?? []).compactMap { raw -> TranscriptSegment? in
                guard let text = (raw["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !text.isEmpty,
                      let start = raw["start"] as? Double,
                      let end = raw["end"] as? Double,
                      start.isFinite, end.isFinite else { return nil }
                return TranscriptSegment(start: windowStart + start, end: windowStart + max(start, end), text: text)
            }
            return (output.text.trimmingCharacters(in: .whitespacesAndNewlines), windowSegments)
        }
        if !part.text.isEmpty { transcriptParts.append(part.text) }
        segments.append(contentsOf: part.segments)
        synchronizeDefaultStream()
        Memory.clearCache()
        synchronizeDefaultStream()
        let percent = reader.totalFrames > 0
            ? min(99, Int(window.completedFrames * 100 / reader.totalFrames)) : 99
        writeLine(TranscriptionProgressResponse(id: requestID, percent: percent))
    }
    return (transcriptParts.joined(separator: " "), segments)
}

/// Runs Sortformer's streaming path, which keeps memory bounded on long recordings (the offline
/// `generate` encodes the whole file at once). The 16 kHz mono samples are held in memory
/// (about 230 MB per hour), then diarized in 5 s chunks.
private func diarizeAudio(_ model: SortformerModel, from url: URL, requestID: String?) async throws -> [SpeakerSegment] {
    let sampleRate = 16_000
    let chunkSeconds: Float = 5
    let reader = try AudioWindowReader(url: url)
    var samples: [Float] = []
    while let window = try reader.nextWindow() {
        try autoreleasepool {
            samples.append(contentsOf: try resampleAudio(window.samples, from: reader.sampleRate, to: sampleRate))
        }
        // Reading and resampling is the first tenth of the progress.
        let percent = reader.totalFrames > 0 ? min(10, Int(window.completedFrames * 10 / reader.totalFrames)) : 10
        writeLine(TranscriptionProgressResponse(id: requestID, percent: percent))
    }
    guard !samples.isEmpty else { return [] }

    let expectedChunks = max(1, Int((Double(samples.count) / Double(sampleRate) / Double(chunkSeconds)).rounded(.up)))
    var segments: [SpeakerSegment] = []
    var completedChunks = 0
    for try await output in model.generateStream(
        audio: MLXArray(samples), sampleRate: sampleRate, chunkDuration: chunkSeconds,
        threshold: 0.5, minDuration: 0.1, mergeGap: 0.3
    ) {
        for segment in output.segments where segment.end > segment.start {
            segments.append(SpeakerSegment(start: Double(segment.start), end: Double(segment.end),
                                           speaker: segment.speaker))
        }
        completedChunks += 1
        let percent = min(99, 10 + completedChunks * 89 / expectedChunks)
        writeLine(TranscriptionProgressResponse(id: requestID, percent: percent))
    }
    return segments
}

private func generationResponse(id: String?, model: String, generated: GenerationOutput,
                                coldLoadSeconds: Double, clock: ContinuousClock) -> Response {
    synchronizeDefaultStream()
    let cleanupStarted = clock.now
    Memory.clearCache()
    synchronizeDefaultStream()
    let cleanup = seconds(from: cleanupStarted, to: clock.now)
    let memory = memoryStatus()
    let metrics = Metrics(coldLoadSeconds: coldLoadSeconds,
        totalRequestSeconds: generated.elapsedSeconds,
        sessionReleaseSeconds: generated.sessionReleaseSeconds,
        cleanupSeconds: cleanup, ttftSeconds: generated.ttftSeconds,
        promptTokens: generated.promptTokens, generatedTokens: generated.generatedTokens,
        promptSeconds: generated.promptSeconds, generationSeconds: generated.generationSeconds,
        tokensPerSecond: generated.tokensPerSecond,
        requestPeakActiveBytes: generated.requestPeakActiveBytes)
    return Response(id: id, model: model, text: generated.text, embeddings: nil,
                    state: nil, memory: memory, metrics: metrics)
}

private func generate(model: ModelContainer, system: String?, prompt: String,
                      images: [UserInput.Image] = [],
                      processing: UserInput.Processing = .init(resize: CGSize(width: 512, height: 512)),
                      parameters: GenerateParameters,
                      noThinking: Bool, clock: ContinuousClock) async throws -> GenerationOutput {
    let session = ChatSession(model, instructions: system, generateParameters: parameters,
                              processing: processing,
                              additionalContext: noThinking ? ["enable_thinking": false] : nil)
    let started = clock.now
    var firstChunk: Double?
    var output = ""
    var info: GenerateCompletionInfo?
    do {
        for try await event in session.streamDetails(to: prompt, role: .user, images: images, videos: []) {
            switch event {
            case .chunk(let chunk):
                if firstChunk == nil { firstChunk = seconds(from: started, to: clock.now) }
                output += chunk
            case .info(let completion): info = completion
            case .toolCall: break
            }
        }
    } catch {
        await session.synchronize()
        await session.clear()
        await session.synchronize()
        throw error
    }
    let elapsed = seconds(from: started, to: clock.now)
    await session.synchronize()
    synchronizeDefaultStream()
    let requestPeak = Memory.peakMemory
    let releaseStarted = clock.now
    await session.clear()
    await session.synchronize()
    synchronizeDefaultStream()
    let releaseElapsed = seconds(from: releaseStarted, to: clock.now)
    let generatedTokens = info?.generationTokenCount
    let generationSeconds = info?.generateTime
    return GenerationOutput(text: output, elapsedSeconds: elapsed,
        sessionReleaseSeconds: releaseElapsed, ttftSeconds: firstChunk,
        promptTokens: info?.promptTokenCount, generatedTokens: generatedTokens,
        promptSeconds: info?.promptTime, generationSeconds: generationSeconds,
        tokensPerSecond: generatedTokens.flatMap { count in
            let duration = generationSeconds ?? elapsed
            return duration > 0 ? Double(count) / duration : nil
        }, requestPeakActiveBytes: requestPeak)
}

private func embed(_ input: [String], using model: EmbedderModelContainer) async throws -> [[Float]] {
    try await model.perform { context in
        let tokenizer = context.tokenizer
        let encoded = input.map { Array(tokenizer.encode(text: $0, addSpecialTokens: true).prefix(2048)) }
        let maxLength = encoded.reduce(1) { max($0, $1.count) }
        let tokenIds = stacked(encoded.map { tokens in
            MLXArray(tokens + Array(repeating: tokenizer.eosTokenId ?? 0, count: maxLength - tokens.count))
        })
        let mask = stacked(encoded.map { tokens in
            MLXArray((0 ..< maxLength).map { Int32($0 < tokens.count ? 1 : 0) })
        }) .!= 0
        let tokenTypes = MLXArray.zeros(like: tokenIds)
        guard let vectors = context.model(tokenIds, positionIds: nil, tokenTypeIds: tokenTypes,
                                         attentionMask: mask).pooledOutput else {
            throw NSError(domain: "FolioMLX", code: 15,
                          userInfo: [NSLocalizedDescriptionKey: "EmbeddingGemma did not return pooled embeddings."])
        }
        vectors.eval()
        return vectors.map { $0.asArray(Float.self) }
    }
}

private func modelTaskError(_ task: String) -> NSError {
    NSError(domain: "FolioMLX", code: 14, userInfo: [NSLocalizedDescriptionKey: "This helper was started for another task, not \(task)."])
}

private func synchronizeDefaultStream() {
    Stream.defaultStream(Device.defaultDevice()).synchronize()
}

private func stopTokens(for modelID: String) -> [String] {
    let normalized = modelID.lowercased()
    if normalized.contains("gemma-4") || normalized.contains("gemma4") { return ["<turn|>"] }
    if normalized.contains("gemma") { return ["<end_of_turn>"] }
    return []
}
