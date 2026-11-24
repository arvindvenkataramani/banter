import Foundation

/// A model with no weights that answers one fixed text once audio has reached it,
/// for driving the routes in tests. Both modes are resident.
actor ScriptedModel {
    let text: String
    private var heard = false

    init(text: String) { self.text = text }

    func hear(_ samples: [Float]) { if !samples.isEmpty { heard = true } }
    var answer: String { heard ? text : "" }
    func reset() { heard = false }
}

extension LoadedModel {
    static func scripted(id: String, text: String) -> LoadedModel {
        .scripted(id: id, model: ScriptedModel(text: text))
    }
}
