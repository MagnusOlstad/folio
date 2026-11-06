import Foundation
import MLX
import MLXNN

struct DebertaConfig: Decodable {
    let modelType: String
    let vocabSize: Int
    let hiddenSize: Int
    let numHiddenLayers: Int
    let numAttentionHeads: Int
    let intermediateSize: Int
    let maxRelativePositions: Int
    let positionBuckets: Int
    let relativeAttention: Bool
    let posAttType: [String]
    let shareAttKey: Bool
    let layerNormEps: Float
    let padTokenId: Int

    enum CodingKeys: String, CodingKey {
        case modelType = "model_type"
        case vocabSize = "vocab_size", hiddenSize = "hidden_size"
        case numHiddenLayers = "num_hidden_layers", numAttentionHeads = "num_attention_heads"
        case intermediateSize = "intermediate_size", maxRelativePositions = "max_relative_positions"
        case positionBuckets = "position_buckets", relativeAttention = "relative_attention"
        case posAttType = "pos_att_type", shareAttKey = "share_att_key"
        case layerNormEps = "layer_norm_eps", padTokenId = "pad_token_id"
    }
}

final class DebertaEmbeddings: Module {
    @ModuleInfo var word_embeddings: Embedding
    @ModuleInfo var layer_norm: LayerNorm

    init(config: DebertaConfig) {
        self.word_embeddings = Embedding(embeddingCount: config.vocabSize, dimensions: config.hiddenSize)
        self.layer_norm = LayerNorm(dimensions: config.hiddenSize, eps: config.layerNormEps)
    }

    func callAsFunction(_ inputIds: MLXArray, attentionMask: MLXArray) -> MLXArray {
        layer_norm(word_embeddings(inputIds)) * attentionMask[.ellipsis, .newAxis].asType(.float32)
    }
}

func relativePositionMatrix(_ length: Int, buckets: Int, maximum: Int) -> [[Int32]] {
    let middle = buckets / 2
    return (0..<length).map { row in
        (0..<length).map { column in
            let relative = row - column
            guard buckets > 0, maximum > 0 else { return Int32(relative) }
            let absolute = abs(relative) < middle ? middle - 1 : abs(relative)
            guard absolute > middle else { return Int32(relative) }
            let logarithm = ceil(log(Double(absolute) / Double(middle)) /
                                 log(Double(maximum - 1) / Double(middle)) * Double(middle - 1)) + Double(middle)
            return Int32(logarithm * (relative < 0 ? -1 : 1))
        }
    }
}

private func relativePositions(_ length: Int, buckets: Int, maximum: Int) -> MLXArray {
    MLXArray(relativePositionMatrix(length, buckets: buckets, maximum: maximum).flatMap { $0 })
        .reshaped([length, length])
}

private func positionGatherIndices(_ length: Int, config: DebertaConfig) -> (MLXArray?, MLXArray?) {
    let relative = relativePositions(length, buckets: config.positionBuckets, maximum: config.maxRelativePositions)
    let span = config.positionBuckets
    let c2p = config.posAttType.contains("c2p") ? clip(relative + span, min: 0, max: 2 * span - 1)[.newAxis, .newAxis] : nil
    let p2c = config.posAttType.contains("p2c") ? clip(-relative + span, min: 0, max: 2 * span - 1)[.newAxis, .newAxis] : nil
    return (c2p, p2c)
}

final class DisentangledSelfAttention: Module {
    @ModuleInfo var query_proj: Linear
    @ModuleInfo var key_proj: Linear
    @ModuleInfo var value_proj: Linear
    let config: DebertaConfig

    init(config: DebertaConfig) {
        self.config = config
        self.query_proj = Linear(config.hiddenSize, config.hiddenSize)
        self.key_proj = Linear(config.hiddenSize, config.hiddenSize)
        self.value_proj = Linear(config.hiddenSize, config.hiddenSize)
    }

    private func heads(_ states: MLXArray) -> MLXArray {
        let (batch, length, _) = states.shape3
        let headSize = config.hiddenSize / config.numAttentionHeads
        return states.reshaped([batch, length, config.numAttentionHeads, headSize]).transposed(0, 2, 1, 3)
    }

    func callAsFunction(_ states: MLXArray, attentionMask: MLXArray,
                        relativeEmbeddings: MLXArray, positionIndices: (MLXArray?, MLXArray?)) -> MLXArray {
        let query = heads(query_proj(states))
        let key = heads(key_proj(states))
        let value = heads(value_proj(states))
        let length = states.shape[1]
        let span = config.positionBuckets
        let scaleFactor = 1 + (config.posAttType.contains("c2p") ? 1 : 0) + (config.posAttType.contains("p2c") ? 1 : 0)
        let scale = sqrt(Float(config.hiddenSize / config.numAttentionHeads * scaleFactor))
        var scores = (query.matmul(key.transposed(0, 1, 3, 2))) / scale
        let relative = relativeEmbeddings[0 ..< 2 * span][.newAxis]
        guard config.shareAttKey else { fatalError("validated DeBERTa config requires shared attention keys") }
        let positionQuery = heads(query_proj(relative))
        let positionKey = heads(key_proj(relative))
        if let c2pIndices = positionIndices.0 {
            let c2p = query.matmul(positionKey.transposed(0, 1, 3, 2))
            let gather = broadcast(c2pIndices, to: [states.shape[0], config.numAttentionHeads, length, length])
            scores = scores + takeAlong(c2p, gather, axis: -1) / scale
        }
        if let p2cIndices = positionIndices.1 {
            let p2c = key.matmul(positionQuery.transposed(0, 1, 3, 2))
            let gather = broadcast(p2cIndices, to: [states.shape[0], config.numAttentionHeads, length, length])
            scores = scores + takeAlong(p2c, gather, axis: -1).transposed(0, 1, 3, 2) / scale
        }
        let batch = attentionMask.shape[0]
        let keepQueries = attentionMask.reshaped([batch, 1, length, 1])
        let keepKeys = attentionMask.reshaped([batch, 1, 1, length])
        let keep = keepQueries .&& keepKeys
        scores = MLX.where(keep, scores, MLXArray(-1e4, dtype: scores.dtype))
        let probabilities = softmax(scores, axis: -1)
        return probabilities.matmul(value).transposed(0, 2, 1, 3).reshaped([states.shape[0], length, config.hiddenSize])
    }
}

final class DebertaSelfOutput: Module {
    @ModuleInfo var dense: Linear
    @ModuleInfo var layer_norm: LayerNorm

    init(config: DebertaConfig) {
        self.dense = Linear(config.hiddenSize, config.hiddenSize)
        self.layer_norm = LayerNorm(dimensions: config.hiddenSize, eps: config.layerNormEps)
    }

    func callAsFunction(_ hidden: MLXArray, residual: MLXArray) -> MLXArray {
        layer_norm(dense(hidden) + residual)
    }
}

final class DebertaAttention: Module {
    @ModuleInfo var self_attn: DisentangledSelfAttention
    @ModuleInfo var output: DebertaSelfOutput

    init(config: DebertaConfig) {
        self.self_attn = DisentangledSelfAttention(config: config)
        self.output = DebertaSelfOutput(config: config)
    }

    func callAsFunction(_ states: MLXArray, attentionMask: MLXArray,
                        relativeEmbeddings: MLXArray, positionIndices: (MLXArray?, MLXArray?)) -> MLXArray {
        output(self_attn(states, attentionMask: attentionMask, relativeEmbeddings: relativeEmbeddings,
                         positionIndices: positionIndices), residual: states)
    }
}

final class DebertaIntermediate: Module {
    @ModuleInfo var dense: Linear
    init(config: DebertaConfig) { self.dense = Linear(config.hiddenSize, config.intermediateSize) }
    func callAsFunction(_ states: MLXArray) -> MLXArray { gelu(dense(states)) }
}

final class DebertaOutput: Module {
    @ModuleInfo var dense: Linear
    @ModuleInfo var layer_norm: LayerNorm
    init(config: DebertaConfig) {
        self.dense = Linear(config.intermediateSize, config.hiddenSize)
        self.layer_norm = LayerNorm(dimensions: config.hiddenSize, eps: config.layerNormEps)
    }
    func callAsFunction(_ states: MLXArray, residual: MLXArray) -> MLXArray { layer_norm(dense(states) + residual) }
}

final class DebertaLayer: Module {
    @ModuleInfo var attention: DebertaAttention
    @ModuleInfo var intermediate: DebertaIntermediate
    @ModuleInfo var output: DebertaOutput
    let config: DebertaConfig

    init(config: DebertaConfig) {
        self.config = config
        self.attention = DebertaAttention(config: config)
        self.intermediate = DebertaIntermediate(config: config)
        self.output = DebertaOutput(config: config)
    }

    func callAsFunction(_ states: MLXArray, attentionMask: MLXArray,
                        relativeEmbeddings: MLXArray, positionIndices: (MLXArray?, MLXArray?)) -> MLXArray {
        let attended = attention(states, attentionMask: attentionMask, relativeEmbeddings: relativeEmbeddings,
                                 positionIndices: positionIndices)
        return output(intermediate(attended), residual: attended)
    }
}

final class DebertaEncoder: Module {
    @ModuleInfo var layer_norm: LayerNorm
    @ModuleInfo var rel_embeddings: Embedding
    @ModuleInfo var layers: [DebertaLayer]
    let config: DebertaConfig

    init(config: DebertaConfig) {
        self.config = config
        self.layer_norm = LayerNorm(dimensions: config.hiddenSize, eps: config.layerNormEps)
        self.rel_embeddings = Embedding(embeddingCount: 2 * config.positionBuckets, dimensions: config.hiddenSize)
        self.layers = (0..<config.numHiddenLayers).map { _ in DebertaLayer(config: config) }
    }

    func callAsFunction(_ states: MLXArray, attentionMask: MLXArray) -> MLXArray {
        let positions = MLXArray(Array(0..<(2 * config.positionBuckets)).map(Int32.init))
        let relativeEmbeddings = layer_norm(rel_embeddings(positions))
        let indices = positionGatherIndices(states.shape[1], config: config)
        return layers.reduce(states) { current, layer in
            layer(current, attentionMask: attentionMask, relativeEmbeddings: relativeEmbeddings, positionIndices: indices)
        }
    }
}

final class DebertaModel: Module {
    @ModuleInfo var embeddings: DebertaEmbeddings
    @ModuleInfo var encoder: DebertaEncoder
    let config: DebertaConfig

    init(config: DebertaConfig) {
        self.config = config
        self.embeddings = DebertaEmbeddings(config: config)
        self.encoder = DebertaEncoder(config: config)
    }

    func callAsFunction(_ inputIds: MLXArray, attentionMask: MLXArray) -> MLXArray {
        encoder(embeddings(inputIds, attentionMask: attentionMask), attentionMask: attentionMask)
    }
}
