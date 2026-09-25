import XCTest

@testable import FluidServerSTT

/// A model declares its parameters and its variants separately, and the
/// roster states which parameter values select which variant. Validation checks
/// the declaration against what the code can build; resolution turns a load
/// request into one variant, reading only the declaration.
final class RosterVariantTests: XCTestCase {
    private func chunk(_ ms: Int) -> ParamBinding { ParamBinding(name: "chunkMs", value: ms) }

    private func tier(_ ms: Int) -> RosterVariant { RosterVariant(id: "\(ms)ms", params: [chunk(ms)]) }

    private func nemotron(
        params: [RosterParam]? = [RosterParam(name: "chunkMs", values: [560, 1120])],
        variants: [RosterVariant]? = nil
    ) -> RosterEntry {
        RosterEntry(
            id: "nemotron", name: "Nemotron", key: "nemotron-streaming-en-0.6b", kind: .streaming,
            params: params, variants: variants ?? [tier(560), tier(1120)])
    }

    private func unified(
        params: [RosterParam]? = nil, variants: [RosterVariant]? = nil
    ) -> RosterEntry {
        RosterEntry(
            id: "unified", name: "Unified", key: "parakeet-unified-0.6b", kind: .both,
            params: params, variants: variants)
    }

    private func validated(_ entry: RosterEntry) throws -> ValidatedModel {
        try XCTUnwrap(Roster.validate([entry]).models.first)
    }

    /// Runs `body` and hands back the RosterError it throws, failing otherwise.
    private func rosterError(_ body: () throws -> Void) -> RosterError? {
        do {
            try body()
            XCTFail("expected a roster error, got none")
        } catch let error as RosterError {
            return error
        } catch {
            XCTFail("expected a roster error, got \(error)")
        }
        return nil
    }

    // MARK: - Validation

    func testATieredModelValidatesWithItsVariantsInOrder() throws {
        let model = try validated(nemotron())
        XCTAssertEqual(model.variants.map(\.id), ["560ms", "1120ms"])
        XCTAssertEqual(model.params.map(\.name), ["chunkMs"])
    }

    /// Nemotron's manager cannot be built without a tier, so an entry that
    /// declares no variants has declared a model the server cannot load.
    func testAModelWhoseManagerNeedsAParameterMustDeclareVariants() {
        guard case .variantsRequired(let id, let param) = rosterError({
            _ = try Roster.validate([nemotron(variants: [])])
        }) else { return XCTFail("expected variantsRequired") }
        XCTAssertEqual(id, "nemotron")
        XCTAssertEqual(param, "chunkMs")
    }

    func testEveryVariantMustBindWhatTheManagerNeeds() {
        let bare = RosterVariant(id: "bare", params: [])
        guard case .variantMissingParam(_, let variant, let param) = rosterError({
            _ = try Roster.validate([nemotron(variants: [tier(560), bare])])
        }) else { return XCTFail("expected variantMissingParam") }
        XCTAssertEqual(variant, "bare")
        XCTAssertEqual(param, "chunkMs")
    }

    func testAModelWhoseManagerTakesNoParametersCannotDeclareVariants() {
        guard case .variantsUnsupported(let id) = rosterError({
            _ = try Roster.validate([unified(variants: [RosterVariant(id: "v", params: [])])])
        }) else { return XCTFail("expected variantsUnsupported") }
        XCTAssertEqual(id, "unified")
    }

    func testAParameterTheManagerCannotUseIsRefused() {
        guard case .paramUnusable(let id, let param) = rosterError({
            _ = try Roster.validate([unified(params: [RosterParam(name: "chunkMs", values: [560])])])
        }) else { return XCTFail("expected paramUnusable") }
        XCTAssertEqual(id, "unified")
        XCTAssertEqual(param, "chunkMs")
    }

    func testAParameterValueTheManagerCannotBuildIsRefused() {
        guard case .paramValueUnusable(_, let param, let value) = rosterError({
            _ = try Roster.validate([
                nemotron(
                    params: [RosterParam(name: "chunkMs", values: [560, 999])],
                    variants: [tier(560), tier(999)])
            ])
        }) else { return XCTFail("expected paramValueUnusable") }
        XCTAssertEqual(param, "chunkMs")
        XCTAssertEqual(value, 999)
    }

    func testAVariantMustBindOnlyDeclaredParameters() {
        let stray = RosterVariant(id: "stray", params: [chunk(560), ParamBinding(name: "beam", value: 4)])
        guard case .variantParamUndeclared(_, let variant, let param) = rosterError({
            _ = try Roster.validate([nemotron(variants: [stray, tier(1120)])])
        }) else { return XCTFail("expected variantParamUndeclared") }
        XCTAssertEqual(variant, "stray")
        XCTAssertEqual(param, "beam")
    }

    func testAVariantMustBindADeclaredValue() {
        guard case .variantValueUndeclared(_, let variant, let param, let value) = rosterError({
            _ = try Roster.validate([nemotron(variants: [tier(560), tier(2240)])])
        }) else { return XCTFail("expected variantValueUndeclared") }
        XCTAssertEqual(variant, "2240ms")
        XCTAssertEqual(param, "chunkMs")
        XCTAssertEqual(value, 2240)
    }

    func testVariantIdsAreUnique() {
        let twin = RosterVariant(id: "560ms", params: [chunk(1120)])
        guard case .duplicateVariant(_, let variant) = rosterError({
            _ = try Roster.validate([nemotron(variants: [tier(560), twin])])
        }) else { return XCTFail("expected duplicateVariant") }
        XCTAssertEqual(variant, "560ms")
    }

    /// Two variants the same parameters select cannot be told apart by a load.
    func testVariantsMustBeDistinguishableByTheirParameters() {
        let alias = RosterVariant(id: "fast", params: [chunk(560)])
        guard case .variantsIndistinct(_, let first, let second) = rosterError({
            _ = try Roster.validate([nemotron(variants: [tier(560), alias])])
        }) else { return XCTFail("expected variantsIndistinct") }
        XCTAssertEqual([first, second], ["560ms", "fast"])
    }

    func testParameterNamesAreUnique() {
        let doubled = [RosterParam(name: "chunkMs", values: [560]), RosterParam(name: "chunkMs", values: [1120])]
        guard case .duplicateParam(_, let param) = rosterError({
            _ = try Roster.validate([nemotron(params: doubled)])
        }) else { return XCTFail("expected duplicateParam") }
        XCTAssertEqual(param, "chunkMs")
    }

    // MARK: - Resolution

    func testANamedVariantIsUsedAsNamed() throws {
        let resolved = try validated(nemotron()).resolve(variant: "1120ms", params: [])
        XCTAssertEqual(resolved?.id, "1120ms")
    }

    func testParametersSelectTheVariantTheyMapTo() throws {
        let resolved = try validated(nemotron()).resolve(variant: nil, params: [chunk(1120)])
        XCTAssertEqual(resolved?.id, "1120ms")
    }

    func testAVariantAndTheParametersThatSelectItAgree() throws {
        let resolved = try validated(nemotron()).resolve(variant: "560ms", params: [chunk(560)])
        XCTAssertEqual(resolved?.id, "560ms")
    }

    /// Either silent winner would report a model as resident that is not.
    func testAVariantAndParametersSelectingAnotherAreAnError() throws {
        let model = try validated(nemotron())
        guard case .variantConflict(_, let named, let param, let selects) = rosterError({
            _ = try model.resolve(variant: "560ms", params: [chunk(1120)])
        }) else { return XCTFail("expected variantConflict") }
        XCTAssertEqual(named, "560ms")
        XCTAssertEqual(param, chunk(1120))
        XCTAssertEqual(selects, "1120ms")
    }

    func testAnUnresolvedChoiceIsRefusedNamingTheChoices() throws {
        let model = try validated(nemotron())
        guard case .variantRequired(_, let offered) = rosterError({
            _ = try model.resolve(variant: nil, params: [])
        }) else { return XCTFail("expected variantRequired") }
        XCTAssertEqual(offered.map(\.id), ["560ms", "1120ms"])
    }

    func testAnUnknownVariantIsRefused() throws {
        let model = try validated(nemotron())
        guard case .variantUnknown(_, let requested, let offered) = rosterError({
            _ = try model.resolve(variant: "80ms", params: [])
        }) else { return XCTFail("expected variantUnknown") }
        XCTAssertEqual(requested, "80ms")
        XCTAssertEqual(offered, ["560ms", "1120ms"])
    }

    func testAnUndeclaredParameterIsRefused() throws {
        let model = try validated(unified())
        guard case .paramUnsupported(let id, let param) = rosterError({
            _ = try model.resolve(variant: nil, params: [chunk(560)])
        }) else { return XCTFail("expected paramUnsupported") }
        XCTAssertEqual(id, "unified")
        XCTAssertEqual(param, "chunkMs")
    }

    func testAnUndeclaredParameterValueIsRefused() throws {
        let model = try validated(nemotron())
        guard case .paramValueUnknown(_, let param, let value, let offered) = rosterError({
            _ = try model.resolve(variant: nil, params: [chunk(2240)])
        }) else { return XCTFail("expected paramValueUnknown") }
        XCTAssertEqual(param, "chunkMs")
        XCTAssertEqual(value, 2240)
        XCTAssertEqual(offered, [560, 1120])
    }

    func testAVariantIsRefusedOnAModelThatHasNone() throws {
        let model = try validated(unified())
        guard case .variantUnknown(_, let requested, let offered) = rosterError({
            _ = try model.resolve(variant: "560ms", params: [])
        }) else { return XCTFail("expected variantUnknown") }
        XCTAssertEqual(requested, "560ms")
        XCTAssertEqual(offered, [])
    }

    func testAModelWithoutVariantsResolvesToItsImplicitOne() throws {
        XCTAssertNil(try validated(unified()).resolve(variant: nil, params: []))
    }

    /// Resolution reads only the declaration. A parameter no variant binds is
    /// accepted and selects nothing — built past validation, since no manager
    /// here takes such a parameter yet.
    func testAParameterMappedToNoVariantSelectsNothing() throws {
        let entry = RosterEntry(
            id: "m", name: "M", key: "nemotron-streaming-en-0.6b", kind: .streaming,
            params: [
                RosterParam(name: "chunkMs", values: [560, 1120]),
                RosterParam(name: "beam", values: [1, 4]),
            ],
            variants: [tier(560), tier(1120)])
        let model = ValidatedModel(entry: entry, family: .nemotron)
        let resolved = try model.resolve(
            variant: nil, params: [chunk(560), ParamBinding(name: "beam", value: 4)])
        XCTAssertEqual(resolved?.id, "560ms")
    }
}
