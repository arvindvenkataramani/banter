/// How the resident model brings weights up. Injected so tests can stand in
/// managers that load instantly or on a signal.
struct ModelBuilder: Sendable {
    var load: @Sendable (ValidatedModel, LoadMode, RosterVariant?) async throws -> LoadedModel
    /// Nil when the mode was already up.
    var addMode: @Sendable (LoadedModel, LoadMode) async throws -> LoadedModel?
    /// Whether the model's weights are on this machine. A request never loads
    /// one that is not: loading would fetch it, and server code never downloads.
    var isPresent: @Sendable (ValidatedModel) -> Bool = { $0.present }

    static let live = ModelBuilder(
        load: { model, mode, variant in
            try await LoadedModel.load(model, mode: mode, variant: variant)
        },
        addMode: { current, mode in try await current.adding(mode: mode) })
}
