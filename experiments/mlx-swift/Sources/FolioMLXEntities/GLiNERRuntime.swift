import CryptoKit
import Foundation
import MLX
import MLXNN
import Tokenizers

public let glinerMultiModelID = "fastino/gliner2.5-multi-v1"
public let glinerMultiRevision = "7b005274e82da37dcf1f5fd9d6a2ef413c6a004c"
public let glinerReferenceRevision = "4857a6b018e5e214616bbfa8f0f6da92af258ba2"
public let entitySchemaVersion = "folio-entities-v1"
public let entityDefaultTokenBudget = 512
public let glinerMultiRequiredFiles = [
    "config.json", "encoder_config/config.json", "model.safetensors",
    "tokenizer.json", "tokenizer_config.json",
]

private let pinnedFileHashes: [String: String] = [
    "config.json": "3e4a96bf01da1094180f2d8998411c1a9fd6e2ae4b5b3e4bc6950318cee95bb7",
    "encoder_config/config.json": "fa4f9ef2903b5369ab172333aae4574e6a476511d7465845cf59f8360ee18716",
    "model.safetensors": "c1ff4ec0bc00031c15530b8f3c33d3677f27949e6a0cb52e1247a6224b6c5395",
    "tokenizer.json": "c62446df87ae18ec98b133f8f84fc449a07cc89bbf8ef192a4cb5f9c53777a7a",
    "tokenizer_config.json": "0bf3ea0873234bd9bfdd3853c440395009ac6365a925b91654daed5396d655e1",
]

private func sha256(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var digest = SHA256()
    while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { digest.update(data: data) }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
}

private func validateSnapshot(_ directory: URL) throws -> ([String: Any], DebertaConfig) {
    for (relativePath, expectedHash) in pinnedFileHashes {
        let file = directory.appendingPathComponent(relativePath)
        guard FileManager.default.fileExists(atPath: file.path) else {
            throw EntityRuntimeError.invalidInput("pinned GLiNER2.5 snapshot is missing \(relativePath)")
        }
        guard try sha256(of: file) == expectedHash else {
            throw EntityRuntimeError.invalidInput("pinned GLiNER2.5 snapshot file failed SHA-256 validation: \(relativePath)")
        }
    }
    let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("config.json")))
    guard let config = raw as? [String: Any],
          config["architecture"] as? String == "boundary",
          config["architecture_version"] as? Int == 1,
          config["model_type"] as? String == "gliner2",
          config["model_name"] as? String == "microsoft/mdeberta-v3-base",
          config["max_len"] as? Int == 4096,
          config["token_pooling"] as? String == "first",
          let settings = config["boundary_head"] as? [String: Any],
          settings["candidate_pool"] as? String == "shared",
          settings["candidate_attention_layers"] as? Int == 0,
          settings["query_attention_layers"] as? Int == 0,
          settings["overlap_policy"] as? String == "flat",
          settings["enable_abstention"] as? Bool == true else {
        throw EntityRuntimeError.unsupportedConfiguration("only the pinned GLiNER2.5 Multi boundary/shared-pool variant is supported")
    }
    let encoderData = try Data(contentsOf: directory.appendingPathComponent("encoder_config/config.json"))
    let encoder = try JSONDecoder().decode(DebertaConfig.self, from: encoderData)
    guard encoder.modelType == "deberta-v2", encoder.vocabSize == 250_112,
          encoder.hiddenSize == 768, encoder.numHiddenLayers == 12,
          encoder.numAttentionHeads == 12, encoder.intermediateSize == 3_072,
          encoder.positionBuckets == 256, encoder.relativeAttention,
          encoder.shareAttKey, Set(encoder.posAttType) == Set(["p2c", "c2p"]) else {
        throw EntityRuntimeError.unsupportedConfiguration("encoder config differs from the pinned mDeBERTa-v3-base architecture")
    }
    guard settings["boundary_attention_layers"] as? Int == 2,
          settings["boundary_refinement_layers"] as? Int == 1,
          settings["boundary_dim"] as? Int == 128,
          settings["pool_boundary_top_k"] as? Int == 32,
          settings["pool_size"] as? Int == 192 else {
        throw EntityRuntimeError.unsupportedConfiguration("boundary head dimensions or layer counts differ from the pinned checkpoint")
    }
    return (config, encoder)
}

private final class GLiNERBoundaryModel: Module {
    @ModuleInfo var encoder: DebertaModel
    @ModuleInfo var boundary_head: BoundaryHead

    init(config: DebertaConfig, settings: [String: Any]) {
        self.encoder = DebertaModel(config: config)
        self.boundary_head = BoundaryHead(hiddenSize: config.hiddenSize, settings: settings)
    }

    func encode(_ ids: MLXArray, attentionMask: MLXArray) -> MLXArray {
        encoder(ids, attentionMask: attentionMask)
    }

    func extract(_ textStates: MLXArray, textMask: MLXArray,
                 queryStates: MLXArray, queryMask: MLXArray) -> (EntityCandidates, MLXArray, MLXArray) {
        boundary_head(textStates: textStates, textMask: textMask, queryStates: queryStates, queryMask: queryMask)
    }
}

private func flatten(_ item: NestedItem<String, MLXArray>, prefix: [String] = []) -> [String] {
    switch item {
    case .none: return []
    case .value: return [prefix.joined(separator: ".")]
    case .array(let values):
        return values.enumerated().flatMap { flatten($0.element, prefix: prefix + [String($0.offset)]) }
    case .dictionary(let values):
        return values.flatMap { key, value in flatten(value, prefix: prefix + [key]) }
    }
}

private func remapWeightName(_ source: String) -> String {
    source.replacingOccurrences(of: "encoder.encoder.layer.", with: "encoder.encoder.layers.")
        .replacingOccurrences(of: ".attention.self.", with: ".attention.self_attn.")
        .replacingOccurrences(of: ".LayerNorm.", with: ".layer_norm.")
}

public struct EntityExtractionResult: Encodable, Sendable, Equatable {
    public let mentions: [EntityMention]
    public let coverage: EntityCoverage
    public let tokenCount: Int
    public let requestSeconds: Double
    public let requestPeakActiveBytes: Int
}

public final class GLiNER2MultiRuntime {
    private let tokenizer: any Tokenizer
    private let model: GLiNERBoundaryModel
    public let modelDirectory: URL

    private init(tokenizer: any Tokenizer, model: GLiNERBoundaryModel, modelDirectory: URL) {
        self.tokenizer = tokenizer
        self.model = model
        self.modelDirectory = modelDirectory
    }

    public static func load(from directory: URL) async throws -> GLiNER2MultiRuntime {
        let (config, encoderConfig) = try validateSnapshot(directory)
        guard let settings = config["boundary_head"] as? [String: Any] else {
            throw EntityRuntimeError.unsupportedConfiguration("boundary_head settings are missing")
        }
        let model = GLiNERBoundaryModel(config: encoderConfig, settings: settings)
        let tensors = try MLX.loadArrays(url: directory.appendingPathComponent("model.safetensors"))
        let expectedPaths = Set(flatten(model.parameters().asItem()))
        var remapped: [[String]: MLXArray] = [:]
        var unknown: [String] = []
        for (sourceName, tensor) in tensors {
            let targetName = remapWeightName(sourceName)
            if expectedPaths.contains(targetName) {
                remapped[targetName.split(separator: ".").map(String.init)] = tensor
            } else if !isKnownUnusedWeight(sourceName) {
                unknown.append(sourceName)
            }
        }
        guard unknown.isEmpty else {
            throw EntityRuntimeError.unsupportedConfiguration("checkpoint contains unknown tensors: \(unknown.sorted().prefix(8).joined(separator: ", "))")
        }
        let presentPaths = Set(remapped.keys.map { $0.joined(separator: ".") })
        let missing = expectedPaths.subtracting(presentPaths).sorted()
        guard missing.isEmpty else { throw EntityRuntimeError.incompleteWeights(missing) }
        do {
            let dotted = Dictionary(uniqueKeysWithValues: remapped.map { ($0.key.joined(separator: "."), $0.value) })
            try model.update(parameters: ModuleParameters.unflattened(dotted), verify: .all)
        } catch {
            throw EntityRuntimeError.invalidInput("checkpoint tensor names or shapes do not match the native model: \(error.localizedDescription)")
        }
        let tokenizer = try await loadPinnedTokenizer(from: directory)
        let tokenizerJSON = try JSONSerialization.jsonObject(
            with: Data(contentsOf: directory.appendingPathComponent("tokenizer.json"))) as? [String: Any]
        let addedTokens = tokenizerJSON?["added_tokens"] as? [[String: Any]] ?? []
        let addedTokenIDs = Dictionary(uniqueKeysWithValues: addedTokens.compactMap { token -> (String, Int)? in
            guard let content = token["content"] as? String, let id = token["id"] as? Int else { return nil }
            return (content, id)
        })
        for (marker, expectedID) in EntityText.addedSchemaTokenIDs where addedTokenIDs[marker] != expectedID {
            throw EntityRuntimeError.unsupportedConfiguration("pinned tokenizer schema marker \(marker) has an unexpected token ID")
        }
        return GLiNER2MultiRuntime(tokenizer: tokenizer, model: model, modelDirectory: directory)
    }

    private static func isKnownUnusedWeight(_ name: String) -> Bool {
        ["boundary_head.boundary_proposer.", "boundary_head.pair_scorer.",
         "boundary_head.candidate_encoder.", "record_decoder.", "relation_scorer.",
         "classifier."].contains { name.hasPrefix($0) }
    }

    public func extractEntities(text: String, schemaVersion: String, labels: [EntityLabel],
                                region: EntityRegion? = nil, maxTokens: Int = entityDefaultTokenBudget,
                                scoreThreshold: Float = 0.5) throws -> EntityExtractionResult {
        guard schemaVersion == entitySchemaVersion else {
            throw EntityRuntimeError.invalidInput("schemaVersion must be \(entitySchemaVersion)")
        }
        guard scoreThreshold.isFinite, scoreThreshold >= 0, scoreThreshold <= 1 else {
            throw EntityRuntimeError.invalidInput("scoreThreshold must be a finite number between 0 and 1")
        }
        let source = text as NSString
        let selectedRegion = region ?? EntityRegion(startUtf16: 0, endUtf16: source.length)
        let clock = ContinuousClock()
        let started = clock.now
        Memory.peakMemory = 0
        let prepared = try EntityText.prepare(fullText: text, region: selectedRegion,
                                              labels: labels,
                                              encode: { tokenizer.encode(text: $0, addSpecialTokens: false) },
                                              unknownTokenID: tokenizer.unknownTokenId, maxTokens: maxTokens)
        guard !labels.isEmpty else {
            return EntityExtractionResult(mentions: [], coverage: EntityCoverage(
                startUtf16: selectedRegion.startUtf16, endUtf16: selectedRegion.endUtf16, complete: true),
                tokenCount: prepared.ids.count, requestSeconds: 0, requestPeakActiveBytes: 0)
        }
        guard !prepared.wordPositions.isEmpty else {
            return EntityExtractionResult(mentions: [], coverage: EntityCoverage(
                startUtf16: selectedRegion.startUtf16, endUtf16: selectedRegion.endUtf16, complete: true),
                tokenCount: prepared.ids.count, requestSeconds: 0, requestPeakActiveBytes: 0)
        }
        let ids = MLXArray(prepared.ids.map(Int32.init)).reshaped([1, prepared.ids.count])
        let mask = MLXArray.ones([1, prepared.ids.count], dtype: .bool)
        let encoded = model.encode(ids, attentionMask: mask)
        let textStates = encoded.take(MLXArray(prepared.wordPositions.map(Int32.init)), axis: 1)
        let queryPositions = Array(prepared.markerPositions.dropFirst()).map(Int32.init)
        guard queryPositions.count == labels.count else {
            throw EntityRuntimeError.invalidInput("schema marker count does not match entity label count")
        }
        let queryStates = encoded.take(MLXArray(queryPositions), axis: 1)
        let textMask = MLXArray.ones([1, prepared.wordPositions.count], dtype: .bool)
        let queryMask = MLXArray.ones([1, queryPositions.count], dtype: .bool)
        let (candidates, logits, nullLogits) = model.extract(textStates, textMask: textMask,
                                                              queryStates: queryStates, queryMask: queryMask)
        let scores = sigmoid(logits.asType(.float32))[0].asArray(Float.self)
        let active = candidates.mask[0].asArray(Bool.self)
        let candidateIndices = candidates.indices[0].asArray(Int32.self)
        let abstentions = sigmoid(nullLogits.asType(.float32))[0].asArray(Float.self).map { $0 > 0.5 }
        let queryCount = labels.count
        let candidateCount = active.count
        var mentions: [EntityMention] = []
        for (query, label) in labels.enumerated() {
            var spans: [(score: Float, start: Int, end: Int)] = []
            if !abstentions[query] {
                for candidate in 0..<candidateCount where active[candidate] {
                    let score = scores[candidate * queryCount + query]
                    let start = Int(candidateIndices[candidate * 2])
                    let end = Int(candidateIndices[candidate * 2 + 1])
                    guard score >= scoreThreshold, start < end, end <= prepared.wordOffsets.count else { continue }
                    spans.append((score, start, end))
                }
            }
            for span in resolveFlatOverlaps(spans) {
                let start = prepared.wordOffsets[span.start].startUtf16
                let end = prepared.wordOffsets[span.end - 1].endUtf16
                guard end > start else { continue }
                let exact = try EntityText.exactSlice(text, startUtf16: start, endUtf16: end)
                mentions.append(EntityMention(text: exact, type: label.type, score: span.score,
                                              startUtf16: start, endUtf16: end))
            }
        }
        synchronizeDefaultStream()
        let peakMemory = Memory.peakMemory
        let elapsed = started.duration(to: clock.now).components
        let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
        return EntityExtractionResult(mentions: mentions, coverage: EntityCoverage(
            startUtf16: selectedRegion.startUtf16, endUtf16: selectedRegion.endUtf16, complete: true),
            tokenCount: prepared.ids.count, requestSeconds: seconds, requestPeakActiveBytes: peakMemory)
    }

    public func planEntityChunks(text: String, schemaVersion: String, labels: [EntityLabel],
                                 maxTokens: Int = entityDefaultTokenBudget,
                                 overlapTokens: Int = 32) throws -> EntityChunkPlanResult {
        guard schemaVersion == entitySchemaVersion else {
            throw EntityRuntimeError.invalidInput("schemaVersion must be \(entitySchemaVersion)")
        }
        return try EntityText.plan(fullText: text, labels: labels,
                                   encode: { tokenizer.encode(text: $0, addSpecialTokens: false) },
                                   unknownTokenID: tokenizer.unknownTokenId,
                                   maxTokens: maxTokens, overlapTokens: overlapTokens)
    }

}

private func loadPinnedTokenizer(from snapshot: URL) async throws -> any Tokenizer {
    let configuration = snapshot.appendingPathComponent("tokenizer_config.json")
    let data = try Data(contentsOf: configuration)
    guard var json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["tokenizer_class"] as? String == "DebertaV2Tokenizer" else {
        throw EntityRuntimeError.unsupportedConfiguration("tokenizer class differs from the pinned DeBERTa-v2 tokenizer")
    }

    // swift-transformers 1.3.0 has no DebertaV2Tokenizer entry. This checkpoint's
    // tokenizer.json declares the faithful Unigram/SentencePiece model used by
    // XLM-R; map only the unsupported class name and keep the pinned tokenizer
    // JSON (normalizer, pre-tokenizer, added tokens and post-processor) intact.
    // The original file hash is verified before making this private adapter copy.
    json["tokenizer_class"] = "XLMRobertaTokenizer"
    let adapter = FileManager.default.temporaryDirectory
        .appendingPathComponent("folio-gliner-tokenizer-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: adapter, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: adapter) }
    try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        .write(to: adapter.appendingPathComponent("tokenizer_config.json"), options: .atomic)
    try FileManager.default.copyItem(at: snapshot.appendingPathComponent("tokenizer.json"),
                                     to: adapter.appendingPathComponent("tokenizer.json"))
    return try await AutoTokenizer.from(modelFolder: adapter, strict: true)
}

private func resolveFlatOverlaps(_ spans: [(score: Float, start: Int, end: Int)]) -> [(score: Float, start: Int, end: Int)] {
    guard !spans.isEmpty else { return [] }
    let ordered = spans.sorted { ($0.end, $0.start, -$0.score) < ($1.end, $1.start, -$1.score) }
    var best: [(Float, [Int])] = [(0, [])]
    for index in ordered.indices {
        let predecessor = ordered[..<index].indices.last(where: { ordered[$0].end <= ordered[index].start })
        let previousIndex = predecessor.map { $0 + 1 } ?? 0
        let previous = best[previousIndex]
        let selected = (previous.0 + ordered[index].score, previous.1 + [index])
        let skipped = best[index]
        best.append(selected.0 > skipped.0 ? selected : skipped)
    }
    return best.last!.1.map { ordered[$0] }.sorted {
        if $0.score != $1.score { return $0.score > $1.score }
        if $0.start != $1.start { return $0.start < $1.start }
        return $0.end < $1.end
    }
}

private func synchronizeDefaultStream() {
    Stream.defaultStream(Device.defaultDevice()).synchronize()
}
