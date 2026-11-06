import Foundation
import MLX
import MLXNN

private let boundaryMaskLogit: Float = -10_000

private func gatherRows(_ states: MLXArray, _ indices: MLXArray) -> MLXArray {
    stacked((0..<states.shape[0]).map { row in states[row].take(indices[row], axis: 0) })
}

final class ResidualSwiGLU: Module {
    @ModuleInfo var norm: LayerNorm
    @ModuleInfo var input_projection: Linear
    @ModuleInfo var output_projection: Linear
    let hidden: Int

    init(dim: Int, multiplier: Float) {
        hidden = max(1, Int(Float(dim) * multiplier))
        norm = LayerNorm(dimensions: dim)
        input_projection = Linear(dim, hidden * 2)
        output_projection = Linear(hidden, dim)
    }

    func callAsFunction(_ states: MLXArray) -> MLXArray {
        let projected = input_projection(norm(states))
        let value = projected[.ellipsis, 0..<hidden]
        let gate = projected[.ellipsis, hidden..<(hidden * 2)]
        return states + output_projection(value * silu(gate))
    }
}

final class BoundaryAttentionBlock: Module {
    @ModuleInfo var norm: LayerNorm
    @ModuleInfo var qkv_projection: Linear
    @ModuleInfo var output_projection: Linear
    let heads: Int
    let headSize: Int
    let window: Int

    init(dim: Int, heads: Int, window: Int) {
        self.heads = heads
        headSize = dim / heads
        self.window = window
        norm = LayerNorm(dimensions: dim)
        qkv_projection = Linear(dim, dim * 3)
        output_projection = Linear(dim, dim)
    }

    func callAsFunction(_ states: MLXArray, mask: MLXArray) -> MLXArray {
        let (batch, length, dim) = states.shape3
        let projected = qkv_projection(norm(states)).reshaped([batch, length, 3, heads, headSize])
        let query = projected.take(MLXArray([Int32(0)]), axis: 2).squeezed(axis: 2).transposed(0, 2, 1, 3)
        let key = projected.take(MLXArray([Int32(1)]), axis: 2).squeezed(axis: 2).transposed(0, 2, 1, 3)
        let value = projected.take(MLXArray([Int32(2)]), axis: 2).squeezed(axis: 2).transposed(0, 2, 1, 3)
        var allowed = mask.reshaped([batch, 1, 1, length]).asType(.bool)
        if window > 0 {
            let positions = MLXArray(Array(0..<length).map(Int32.init))
            let local = abs(positions[.ellipsis, .newAxis] - positions[.newAxis, .ellipsis]) .<= window
            allowed = allowed .&& local.reshaped([1, 1, length, length])
        }
        let diagonal = MLXArray.eye(length, dtype: .bool).reshaped([1, 1, length, length])
        allowed = allowed .|| diagonal
        let attentionMask = MLX.where(allowed, 0, boundaryMaskLogit).asType(states.dtype)
        let attended = MLXFast.scaledDotProductAttention(
            queries: query,
            keys: key,
            values: value,
            scale: 1 / sqrt(Float(headSize)),
            mask: .array(attentionMask)
        ).transposed(0, 2, 1, 3).reshaped([batch, length, dim])
        return (states + output_projection(attended)) * mask[.ellipsis, .newAxis].asType(states.dtype)
    }
}

final class BoundaryEncoder: Module {
    @ModuleInfo var left_projection: Linear
    @ModuleInfo var right_projection: Linear
    @ModuleInfo var output_projection: Linear
    @ModuleInfo var layer_norm: LayerNorm
    @ModuleInfo var attention_blocks: [BoundaryAttentionBlock]
    @ModuleInfo var refinement_blocks: [ResidualSwiGLU]
    @ParameterInfo var bos_state: MLXArray
    @ParameterInfo var eos_state: MLXArray
    let hiddenSize: Int

    init(hiddenSize: Int, settings: [String: Any], boundaryDim: Int) {
        self.hiddenSize = hiddenSize
        left_projection = Linear(hiddenSize, boundaryDim)
        right_projection = Linear(hiddenSize, boundaryDim)
        output_projection = Linear(boundaryDim * 2, boundaryDim)
        layer_norm = LayerNorm(dimensions: boundaryDim)
        attention_blocks = (0..<((settings["boundary_attention_layers"] as? Int) ?? 0)).map { _ in
            BoundaryAttentionBlock(dim: boundaryDim,
                                   heads: settings["boundary_attention_heads"] as? Int ?? 4,
                                   window: settings["boundary_attention_window"] as? Int ?? 0)
        }
        refinement_blocks = (0..<((settings["boundary_refinement_layers"] as? Int) ?? 1)).map { _ in
            ResidualSwiGLU(dim: boundaryDim, multiplier: settings["boundary_ffn_multiplier"] as? Float ?? 2)
        }
        _bos_state.wrappedValue = MLXArray.zeros([hiddenSize])
        _eos_state.wrappedValue = MLXArray.zeros([hiddenSize])
    }

    func callAsFunction(_ textStates: MLXArray, textMask: MLXArray) -> (MLXArray, MLXArray) {
        let batch = textStates.shape[0]
        let length = textStates.shape[1]
        let lengths = sum(textMask, axis: 1).asType(.int32)
        let bos = broadcast(bos_state, to: [batch, 1, hiddenSize])
        let eos = broadcast(eos_state, to: [batch, 1, hiddenSize])
        let left = concatenated([bos, textStates], axis: 1)
        var right = concatenated([textStates, eos], axis: 1)
        let positions = MLXArray(Array(0...length).map(Int32.init))[.newAxis, .ellipsis, .newAxis]
        right = MLX.where(positions .== lengths[.ellipsis, .newAxis, .newAxis], eos, right)
        var states = layer_norm(output_projection(concatenated([
            left_projection(left), right_projection(right)
        ], axis: -1)))
        let boundaryMask = (MLXArray(Array(0...length).map(Int32.init))[.newAxis] .<= lengths[.ellipsis, .newAxis])
        for block in attention_blocks { states = block(states, mask: boundaryMask) }
        for block in refinement_blocks { states = block(states) }
        states = states * boundaryMask[.ellipsis, .newAxis].asType(states.dtype)
        return (states, boundaryMask)
    }
}

final class BoundaryQueryHead: Module {
    @ModuleInfo var start_boundary_projection: Linear
    @ModuleInfo var start_query_projection: Linear
    @ModuleInfo var end_boundary_projection: Linear
    @ModuleInfo var end_query_projection: Linear
    @ModuleInfo var inside_text_projection: Linear
    @ModuleInfo var inside_query_projection: Linear
    let boundaryDim: Int

    init(hiddenSize: Int, boundaryDim: Int) {
        self.boundaryDim = boundaryDim
        start_boundary_projection = Linear(boundaryDim, boundaryDim)
        start_query_projection = Linear(hiddenSize, boundaryDim)
        end_boundary_projection = Linear(boundaryDim, boundaryDim)
        end_query_projection = Linear(hiddenSize, boundaryDim)
        inside_text_projection = Linear(hiddenSize, boundaryDim)
        inside_query_projection = Linear(hiddenSize, boundaryDim)
    }

    func callAsFunction(boundaries: MLXArray, boundaryMask: MLXArray,
                        textStates: MLXArray, textMask: MLXArray,
                        queries: MLXArray, queryMask: MLXArray) -> (MLXArray, MLXArray, MLXArray, MLXArray) {
        let scale = sqrt(Float(boundaryDim))
        let start = start_query_projection(queries).matmul(start_boundary_projection(boundaries).transposed(0, 2, 1)) / scale
        let end = end_query_projection(queries).matmul(end_boundary_projection(boundaries).transposed(0, 2, 1)) / scale
        let inside = inside_query_projection(queries).matmul(inside_text_projection(textStates).transposed(0, 2, 1)) / scale
        let batch = queryMask.shape[0]
        let keepBoundary = boundaryMask.reshaped([batch, 1, boundaryMask.shape[1]]) .&&
            queryMask.reshaped([batch, queryMask.shape[1], 1])
        let keepText = textMask.reshaped([batch, 1, textMask.shape[1]]) .&&
            queryMask.reshaped([batch, queryMask.shape[1], 1])
        let startLogits = MLX.where(keepBoundary, start, boundaryMaskLogit)
        let endLogits = MLX.where(keepBoundary, end, boundaryMaskLogit)
        let insideValues = MLX.where(keepText, inside, 0).asType(.float32)
        let count = maximum(sum(keepText, axis: -1, keepDims: true), 1)
        let mean = stopGradient(sum(insideValues, axis: -1, keepDims: true) / count)
        let centered = (insideValues - mean) * keepText.asType(.float32)
        let prefix = concatenated([MLXArray.zeros([centered.shape[0], centered.shape[1], 1]), cumsum(centered, axis: -1)], axis: -1)
        return (startLogits, endLogits, prefix, mean)
    }
}

struct EntityCandidates {
    let indices: MLXArray
    let mask: MLXArray
    let compatibility: MLXArray
}

final class DocumentCandidatePool: Module {
    @ModuleInfo var start_projection: Linear
    @ModuleInfo var end_projection: Linear
    let topK: Int
    let poolSize: Int
    let minimumPerQuery: Int
    let boundaryDim: Int

    init(boundaryDim: Int, settings: [String: Any]) {
        self.boundaryDim = boundaryDim
        topK = settings["pool_boundary_top_k"] as? Int ?? 32
        poolSize = settings["pool_size"] as? Int ?? settings["candidate_budget"] as? Int ?? 192
        minimumPerQuery = settings["min_pool_per_query"] as? Int ?? 8
        start_projection = Linear(boundaryDim, boundaryDim)
        end_projection = Linear(boundaryDim, boundaryDim)
    }

    func callAsFunction(boundaries: MLXArray, boundaryMask: MLXArray, queryMask: MLXArray,
                        startLogits: MLXArray, endLogits: MLXArray) -> EntityCandidates {
        let batch = boundaries.shape[0]
        let length = boundaries.shape[1]
        let projectedStart = start_projection(boundaries)
        let projectedEnd = end_projection(boundaries)
        var batchIndices: [[Int32]] = []
        var batchMasks: [[Int32]] = []
        var compatibilities: [[Float]] = []
        for row in 0..<batch {
            let active = queryMask[row].asArray(Bool.self)
            let starts = startLogits[row].asArray(Float.self)
            let ends = endLogits[row].asArray(Float.self)
            let boundaryKeep = boundaryMask[row].asArray(Bool.self)
            let queryCount = active.count
            var unionStart = Array(repeating: boundaryMaskLogit, count: length)
            var unionEnd = Array(repeating: boundaryMaskLogit, count: length)
            for query in 0..<queryCount where active[query] {
                for position in 0..<length {
                    unionStart[position] = max(unionStart[position], starts[query * length + position])
                    unionEnd[position] = max(unionEnd[position], ends[query * length + position])
                }
            }
            for position in 0..<length where !boundaryKeep[position] {
                unionStart[position] = boundaryMaskLogit
                unionEnd[position] = boundaryMaskLogit
            }
            let selectedStarts = Array(unionStart.indices.sorted {
                unionStart[$0] == unionStart[$1] ? $0 < $1 : unionStart[$0] > unionStart[$1]
            }.prefix(min(topK, length)))
            let selectedEnds = Array(unionEnd.indices.sorted {
                unionEnd[$0] == unionEnd[$1] ? $0 < $1 : unionEnd[$0] > unionEnd[$1]
            }.prefix(min(topK, length)))
            let projectedLeft = projectedStart[row].asArray(Float.self)
            let projectedRight = projectedEnd[row].asArray(Float.self)
            var pairs: [(start: Int, end: Int, compatibility: Float, priority: Float)] = []
            for start in selectedStarts {
                for end in selectedEnds where end > start {
                    var compatibility: Float = 0
                    for dimension in 0..<boundaryDim {
                        compatibility += projectedLeft[start * boundaryDim + dimension] * projectedRight[end * boundaryDim + dimension]
                    }
                    compatibility /= sqrt(Float(boundaryDim))
                    pairs.append((start, end, compatibility, compatibility + unionStart[start] + unionEnd[end]))
                }
            }
            let quota = min(minimumPerQuery, pairs.count)
            if quota > 0 {
                for query in 0..<queryCount where active[query] {
                    let order = pairs.indices.sorted { left, right in
                        let l = pairs[left]
                        let r = pairs[right]
                        let leftScore = starts[query * length + l.start] + ends[query * length + l.end] + l.compatibility
                        let rightScore = starts[query * length + r.start] + ends[query * length + r.end] + r.compatibility
                        return leftScore == rightScore ? left < right : leftScore > rightScore
                    }
                    for (rank, index) in order.prefix(quota).enumerated() {
                        pairs[index].priority = max(pairs[index].priority, 5_000 + Float(quota - rank))
                    }
                }
            }
            let chosen = Array(pairs.enumerated().sorted {
                $0.element.priority == $1.element.priority ? $0.offset < $1.offset : $0.element.priority > $1.element.priority
            }.prefix(poolSize).map(\.element))
            var indices: [Int32] = chosen.flatMap { [Int32($0.start), Int32($0.end)] }
            var mask = Array(repeating: Int32(1), count: chosen.count)
            var compatibility = chosen.map(\.compatibility)
            while mask.count < poolSize {
                indices.append(contentsOf: [0, 0])
                mask.append(0)
                compatibility.append(0)
            }
            batchIndices.append(indices)
            batchMasks.append(mask)
            compatibilities.append(compatibility)
        }
        let indexArray = MLXArray(batchIndices.flatMap { $0 }).reshaped([batch, poolSize, 2])
        let maskArray = MLXArray(batchMasks.flatMap { $0 }).reshaped([batch, poolSize]) .!= 0
        let starts = indexArray[.ellipsis, 0]
        let ends = indexArray[.ellipsis, 1]
        let projectedLeft = gatherRows(projectedStart, starts)
        let projectedRight = gatherRows(projectedEnd, ends)
        let actualCompatibility = sum(projectedLeft * projectedRight, axis: -1) / sqrt(Float(boundaryDim))
        let fallback = MLXArray(compatibilities.flatMap { $0 }).reshaped([batch, poolSize])
        return EntityCandidates(indices: indexArray, mask: maskArray,
                                compatibility: MLX.where(maskArray, actualCompatibility, fallback))
    }
}

final class SpanContentPooler: Module {
    @ModuleInfo var value_projection: Linear
    @ModuleInfo var layer_norm: LayerNorm

    init(hiddenSize: Int, contentDim: Int) {
        value_projection = Linear(hiddenSize, contentDim)
        layer_norm = LayerNorm(dimensions: contentDim)
    }

    func callAsFunction(textStates: MLXArray, textMask: MLXArray,
                        starts: MLXArray, ends: MLXArray) -> MLXArray {
        let values = value_projection(textStates) * textMask[.ellipsis, .newAxis].asType(.float32)
        let prefix = concatenated([MLXArray.zeros([values.shape[0], 1, values.shape[2]]), cumsum(values.asType(.float32), axis: 1)], axis: 1)
        let endValues = gatherRows(prefix, ends)
        let startValues = gatherRows(prefix, starts)
        let length = maximum(ends - starts, 1)[.ellipsis, .newAxis]
        return layer_norm(((endValues - startValues) / length).asType(values.dtype))
    }
}

final class SharedPoolScorer: Module {
    @ModuleInfo var start_projection: Linear
    @ModuleInfo var end_projection: Linear
    @ModuleInfo var length_projection: Linear
    @ModuleInfo var prior_projection: Linear
    @ModuleInfo var content_pooler: SpanContentPooler
    @ModuleInfo var content_projection: Linear
    @ModuleInfo var candidate_norm: LayerNorm
    @ModuleInfo var query_projection: Linear
    @ModuleInfo var film: Linear
    @ModuleInfo var film_output: [Module]
    let pairDim: Int

    init(hiddenSize: Int, boundaryDim: Int, settings: [String: Any]) {
        pairDim = settings["pair_dim"] as? Int ?? 128
        start_projection = Linear(boundaryDim, pairDim)
        end_projection = Linear(boundaryDim, pairDim)
        length_projection = Linear(3, pairDim)
        prior_projection = Linear(1, pairDim)
        let contentDim = settings["content_dim"] as? Int ?? 64
        content_pooler = SpanContentPooler(hiddenSize: hiddenSize, contentDim: contentDim)
        content_projection = Linear(contentDim, pairDim)
        candidate_norm = LayerNorm(dimensions: pairDim)
        query_projection = Linear(hiddenSize, pairDim)
        film = Linear(pairDim, pairDim * 2)
        film_output = [Linear(pairDim, 64), GELU(), Dropout(p: 0), Linear(64, 1)]
    }

    func callAsFunction(boundaries: MLXArray, queries: MLXArray, queryMask: MLXArray,
                        pooled: EntityCandidates, startLogits: MLXArray, endLogits: MLXArray,
                        insidePrefix: MLXArray, insideMean: MLXArray,
                        textStates: MLXArray, textMask: MLXArray) -> MLXArray {
        let starts = pooled.indices[.ellipsis, 0]
        let ends = pooled.indices[.ellipsis, 1]
        let startRep = gatherRows(start_projection(boundaries), starts)
        let endRep = gatherRows(end_projection(boundaries), ends)
        let lengths = maximum(ends - starts, 1).asType(.float32)
        let textLengths = maximum(sum(textMask, axis: -1), 1)[.ellipsis, .newAxis]
        let features = stacked([log(1 + lengths), lengths / textLengths, rsqrt(lengths)], axis: -1)
        var candidate = startRep + endRep + length_projection(features) +
            prior_projection(pooled.compatibility[.ellipsis, .newAxis]) +
            content_projection(content_pooler(textStates: textStates, textMask: textMask, starts: starts, ends: ends))
        candidate = candidate_norm(candidate) * pooled.mask[.ellipsis, .newAxis].asType(candidate.dtype)
        let query = query_projection(queries)
        var score = candidate.matmul(query.transposed(0, 2, 1)) / sqrt(Float(pairDim))
        let filmParts = film(query)
        let gamma = filmParts[.ellipsis, 0..<pairDim]
        let beta = filmParts[.ellipsis, pairDim..<(pairDim * 2)]
        let conditioned = candidate.reshaped([candidate.shape[0], candidate.shape[1], 1, pairDim]) *
            (1 + gamma.reshaped([gamma.shape[0], 1, gamma.shape[1], pairDim])) +
            beta.reshaped([beta.shape[0], 1, beta.shape[1], pairDim])
        let filmScore = film_output[0] as! Linear
        let filmFinal = film_output[3] as! Linear
        let filmConditioned = filmFinal(gelu(filmScore(conditioned)))[.ellipsis, 0]
        score = score + filmConditioned

        var rows: [MLXArray] = []
        for batch in 0..<score.shape[0] {
            let batchStarts = starts[batch]
            let batchEnds = ends[batch]
            let rowScore = score[batch] + startLogits[batch].take(batchStarts, axis: 1).transposed() +
                endLogits[batch].take(batchEnds, axis: 1).transposed()
            let inside = (insidePrefix[batch].take(batchEnds, axis: 1) -
                          insidePrefix[batch].take(batchStarts, axis: 1)).transposed()
            let interval = inside + (insideMean[batch] * lengths[batch][.newAxis]).transposed()
            let adjusted = rowScore + interval / sqrt(lengths[batch])[.ellipsis, .newAxis]
            rows.append(adjusted)
        }
        score = stacked(rows)
        let batch = queryMask.shape[0]
        let keep = pooled.mask.reshaped([batch, pooled.mask.shape[1], 1]) .&&
            queryMask.reshaped([batch, 1, queryMask.shape[1]])
        return MLX.where(keep, score, boundaryMaskLogit)
    }
}

final class BoundaryHead: Module {
    @ModuleInfo var boundary_encoder: BoundaryEncoder
    @ModuleInfo var boundary_query_head: BoundaryQueryHead
    @ModuleInfo var shared_pool_builder: DocumentCandidatePool
    @ModuleInfo var shared_pool_scorer: SharedPoolScorer
    @ModuleInfo var null_projection: Linear
    @ModuleInfo var count_head: Linear
    let hiddenSize: Int
    let boundaryDim: Int

    init(hiddenSize: Int, settings: [String: Any]) {
        self.hiddenSize = hiddenSize
        boundaryDim = settings["boundary_dim"] as? Int ?? 128
        boundary_encoder = BoundaryEncoder(hiddenSize: hiddenSize, settings: settings, boundaryDim: boundaryDim)
        boundary_query_head = BoundaryQueryHead(hiddenSize: hiddenSize, boundaryDim: boundaryDim)
        shared_pool_builder = DocumentCandidatePool(boundaryDim: boundaryDim, settings: settings)
        shared_pool_scorer = SharedPoolScorer(hiddenSize: hiddenSize, boundaryDim: boundaryDim, settings: settings)
        null_projection = Linear(hiddenSize, 1)
        count_head = Linear(hiddenSize, 1)
    }

    func callAsFunction(textStates: MLXArray, textMask: MLXArray,
                        queryStates: MLXArray, queryMask: MLXArray) -> (EntityCandidates, MLXArray, MLXArray) {
        let (boundaries, boundaryMask) = boundary_encoder(textStates, textMask: textMask)
        let (start, end, inside, mean) = boundary_query_head(
            boundaries: boundaries, boundaryMask: boundaryMask, textStates: textStates,
            textMask: textMask, queries: queryStates, queryMask: queryMask)
        let pooled = shared_pool_builder(boundaries: boundaries, boundaryMask: boundaryMask,
                                         queryMask: queryMask, startLogits: start, endLogits: end)
        let logits = shared_pool_scorer(boundaries: boundaries, queries: queryStates, queryMask: queryMask,
                                        pooled: pooled, startLogits: start, endLogits: end,
                                        insidePrefix: inside, insideMean: mean,
                                        textStates: textStates, textMask: textMask)
        return (pooled, logits, null_projection(queryStates)[.ellipsis, 0])
    }
}
