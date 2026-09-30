import Darwin
import Foundation
import MLX
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import HuggingFace
import Tokenizers

private struct Message: Decodable {
    let role: String
    let content: String
}

private struct Request: Decodable {
    let id: String?
    let messages: [Message]
    let maxTokens: Int?
    let temperature: Float?
    let noThinking: Bool?
}

private struct Response: Encodable {
    let id: String?
    let model: String
    let text: String
    let metrics: Metrics
}

private struct Metrics: Encodable {
    let coldLoadSeconds: Double
    let totalRequestSeconds: Double
    let ttftSeconds: Double?
    let promptTokens: Int?
    let generatedTokens: Int?
    let promptSeconds: Double?
    let generationSeconds: Double?
    let tokensPerSecond: Double?
    let peakResidentBytes: UInt64?
    let mlxActiveBytes: Int
    let mlxCacheBytes: Int
    let mlxPeakBytes: Int
}

private struct ErrorResponse: Encodable {
    let id: String?
    let error: String
}

private func log(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func writeProtocolLine(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func peakResidentBytes() -> UInt64? {
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0, usage.ru_maxrss >= 0 else { return nil }
    return UInt64(usage.ru_maxrss)
}

private func encodeLine<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), let line = String(data: data, encoding: .utf8) else {
        return "{}"
    }
    return line
}

private func requestParts(_ request: Request) throws -> (String, String) {
    guard request.messages.count == 2,
          request.messages.first?.role == "system",
          request.messages.last?.role == "user",
          let system = request.messages.first?.content,
          !system.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw NSError(domain: "FolioMLX", code: 1, userInfo: [NSLocalizedDescriptionKey: "messages must contain exactly one non-empty system message followed by one user message"])
    }
    guard let user = request.messages.last?.content,
          !user.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw NSError(domain: "FolioMLX", code: 2, userInfo: [NSLocalizedDescriptionKey: "user message must not be empty"])
    }
    return (system, user)
}

@main
private struct FolioMLX {
    static func main() async throws {
        var arguments = Array(CommandLine.arguments.dropFirst())
        var modelID = "mlx-community/Qwen3.5-4B-MLX-4bit"
        var modelDirectory: URL?
        var maxTokens = 512
        var temperature: Float = 0.1
        while !arguments.isEmpty {
            let option = arguments.removeFirst()
            guard !arguments.isEmpty else { throw NSError(domain: "FolioMLX", code: 4, userInfo: [NSLocalizedDescriptionKey: "missing value for \(option)"]) }
            let value = arguments.removeFirst()
            switch option {
            case "--model": modelID = value
            case "--model-directory": modelDirectory = URL(fileURLWithPath: value, isDirectory: true)
            case "--max-tokens":
                guard let parsed = Int(value), parsed > 0 else { throw NSError(domain: "FolioMLX", code: 5, userInfo: [NSLocalizedDescriptionKey: "max tokens must be positive"]) }
                maxTokens = parsed
            case "--temperature":
                guard let parsed = Float(value), parsed.isFinite, parsed >= 0 else { throw NSError(domain: "FolioMLX", code: 6, userInfo: [NSLocalizedDescriptionKey: "temperature must be finite and non-negative"]) }
                temperature = parsed
            default: throw NSError(domain: "FolioMLX", code: 7, userInfo: [NSLocalizedDescriptionKey: "unknown option \(option)"])
            }
        }

        let processClock = ContinuousClock()
        let processStarted = processClock.now
        log("Loading native MLX model \(modelID)…")
        let model: ModelContainer
        if let modelDirectory {
            model = try await loadModelContainer(
                from: modelDirectory,
                using: #huggingFaceTokenizerLoader()
            )
        } else {
            model = try await #huggingFaceLoadModelContainer(
                configuration: ModelConfiguration(
                    id: modelID,
                    extraEOSTokens: Set(stopTokens(for: modelID))
                )
            )
        }
        let coldLoadSeconds = seconds(from: processStarted, to: processClock.now)
        let memoryAfterLoad = Memory.snapshot()
        log("Model ready. Reading JSONL requests from stdin.")

        while let line = readLine() {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            var requestID: String?
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                requestID = request.id
                let (system, prompt) = try requestParts(request)
                let requestTokens = request.maxTokens ?? maxTokens
                let requestTemperature = request.temperature ?? temperature
                guard requestTokens > 0 else { throw NSError(domain: "FolioMLX", code: 8, userInfo: [NSLocalizedDescriptionKey: "maxTokens must be positive"]) }
                guard requestTemperature.isFinite, requestTemperature >= 0 else { throw NSError(domain: "FolioMLX", code: 9, userInfo: [NSLocalizedDescriptionKey: "temperature must be finite and non-negative"]) }
                let parameters = GenerateParameters(
                    maxTokens: requestTokens,
                    temperature: requestTemperature
                )
                let session = ChatSession(
                    model,
                    instructions: system,
                    generateParameters: parameters,
                    additionalContext: request.noThinking == false ? nil : ["enable_thinking": false]
                )
                let started = processClock.now
                var firstChunkAt: Double?
                var output = ""
                var info: GenerateCompletionInfo?
                for try await event in session.streamDetails(to: prompt, role: .user, images: [], videos: []) {
                    switch event {
                    case .chunk(let chunk):
                        if firstChunkAt == nil { firstChunkAt = seconds(from: started, to: processClock.now) }
                        output += chunk
                    case .info(let completion): info = completion
                    case .toolCall: break
                    }
                }
                let elapsed = seconds(from: started, to: processClock.now)
                let memoryAfterRequest = Memory.snapshot()
                let generatedTokens = info?.generationTokenCount
                let generationSeconds = info?.generateTime
                let metrics = Metrics(
                    coldLoadSeconds: coldLoadSeconds,
                    totalRequestSeconds: elapsed,
                    ttftSeconds: firstChunkAt,
                    promptTokens: info?.promptTokenCount,
                    generatedTokens: generatedTokens,
                    promptSeconds: info?.promptTime,
                    generationSeconds: generationSeconds,
                    tokensPerSecond: generatedTokens.flatMap { tokens in
                        let seconds = generationSeconds ?? elapsed
                        return seconds > 0 ? Double(tokens) / seconds : nil
                    },
                    peakResidentBytes: peakResidentBytes(),
                    mlxActiveBytes: memoryAfterRequest.activeMemory,
                    mlxCacheBytes: memoryAfterRequest.cacheMemory,
                    mlxPeakBytes: max(memoryAfterLoad.peakMemory, memoryAfterRequest.peakMemory)
                )
                writeProtocolLine(encodeLine(Response(id: requestID, model: modelID, text: output, metrics: metrics)))
            } catch {
                writeProtocolLine(encodeLine(ErrorResponse(id: requestID, error: error.localizedDescription)))
            }
        }
    }
}

private func seconds(from start: ContinuousClock.Instant, to end: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: end).components
    return Double(duration.seconds) + Double(duration.attoseconds) / 1_000_000_000_000_000_000
}

private func stopTokens(for modelID: String) -> [String] {
    let normalized = modelID.lowercased()
    if normalized.contains("qwen") { return ["<|im_end|>"] }
    if normalized.contains("llama") { return ["<|eot_id|>"] }
    if normalized.contains("gemma-4") || normalized.contains("gemma4") { return ["<turn|>"] }
    if normalized.contains("gemma") { return ["<end_of_turn>"] }
    return []
}
