import Darwin
import Foundation
import MLX
import MLXEmbedders
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import HuggingFace
import Tokenizers

private enum TaskKind: String { case generation, embedding }

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
}

private struct MemoryStatus: Encodable {
    let activeBytes: Int
    let cacheBytes: Int
    let peakResidentBytes: UInt64?
}

private struct Response: Encodable {
    let id: String?
    let model: String
    let text: String?
    let embeddings: [[Float]]?
    let state: String?
    let memory: MemoryStatus
    let metrics: Metrics?
}

private struct ReadyResponse: Encodable {
    let event = "ready"
    let model: String
    let task: String
    let memory: MemoryStatus
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
        var modelDirectory: URL?
        var maxTokens = 512
        var temperature: Float = 0.1
        while !arguments.isEmpty {
            let option = arguments.removeFirst()
            guard !arguments.isEmpty else { throw NSError(domain: "FolioMLX", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing value for \(option)"]) }
            let value = arguments.removeFirst()
            switch option {
            case "--task":
                guard let parsed = TaskKind(rawValue: value) else { throw NSError(domain: "FolioMLX", code: 2, userInfo: [NSLocalizedDescriptionKey: "task must be generation or embedding"]) }
                task = parsed
            case "--model": modelID = value
            case "--revision": revision = value
            case "--model-directory": modelDirectory = URL(fileURLWithPath: value, isDirectory: true)
            case "--max-tokens":
                guard let parsed = Int(value), parsed > 0 else { throw NSError(domain: "FolioMLX", code: 3, userInfo: [NSLocalizedDescriptionKey: "max tokens must be positive"]) }
                maxTokens = parsed
            case "--temperature":
                guard let parsed = Float(value), parsed.isFinite, parsed >= 0 else { throw NSError(domain: "FolioMLX", code: 4, userInfo: [NSLocalizedDescriptionKey: "temperature must be finite and non-negative"]) }
                temperature = parsed
            default: throw NSError(domain: "FolioMLX", code: 5, userInfo: [NSLocalizedDescriptionKey: "unknown option \(option)"])
            }
        }

        let clock = ContinuousClock()
        let processStarted = clock.now
        let generator: ModelContainer?
        let embedder: EmbedderModelContainer?
        if task == .generation {
            log("Loading generation model \(modelID)…")
            if let modelDirectory {
                generator = try await loadModelContainer(from: modelDirectory, using: #huggingFaceTokenizerLoader())
            } else {
                generator = try await #huggingFaceLoadModelContainer(
                    configuration: ModelConfiguration(id: modelID, revision: revision,
                        extraEOSTokens: Set(stopTokens(for: modelID)))
                )
            }
            embedder = nil
        } else {
            log("Loading embedding model \(modelID)…")
            if let modelDirectory {
                embedder = try await EmbedderModelFactory.shared.loadContainer(
                    from: modelDirectory, using: #huggingFaceTokenizerLoader())
            } else {
                embedder = try await EmbedderModelFactory.shared.loadContainer(
                    from: #hubDownloader(), using: #huggingFaceTokenizerLoader(),
                    configuration: ModelConfiguration(id: modelID, revision: revision))
            }
            generator = nil
        }
        let coldLoadSeconds = seconds(from: processStarted, to: clock.now)
        synchronizeDefaultStream()
        Memory.clearCache()
        synchronizeDefaultStream()
        log("Model ready. Reading JSONL requests from stdin.")
        writeLine(ReadyResponse(model: modelID, task: task.rawValue, memory: memoryStatus()))

        while let line = readLine() {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let started = clock.now
            var requestID: String?
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                requestID = request.id
                switch request.operation ?? (task == .generation ? "generate" : "embed") {
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
                    writeLine(Response(id: requestID, model: modelID, text: generated.text, embeddings: nil,
                                       state: nil, memory: memory, metrics: metrics))
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

private func generate(model: ModelContainer, system: String, prompt: String, parameters: GenerateParameters,
                      noThinking: Bool, clock: ContinuousClock) async throws -> GenerationOutput {
    let session = ChatSession(model, instructions: system, generateParameters: parameters,
                              additionalContext: noThinking ? ["enable_thinking": false] : nil)
    let started = clock.now
    var firstChunk: Double?
    var output = ""
    var info: GenerateCompletionInfo?
    do {
        for try await event in session.streamDetails(to: prompt, role: .user, images: [], videos: []) {
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
