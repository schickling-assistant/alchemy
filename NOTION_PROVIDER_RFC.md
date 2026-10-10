# RFC draft: observe and adopt additive Notion data-source schemas

This is a local draft, not an upstream issue or PR. The fleet remains independently deployable; adoption by Alchemy is optional.

## Motivation

Notion integrations often consume existing, human-managed databases rather than provisioning greenfield infrastructure. Consumers need to detect revoked access, wrong integration identity, changed parent bindings, and same-named property replacements before running application work. A schema owner should add a few application-owned fields/options without replacing or deleting human-managed schema.

The independently dogfooded implementation is in schickling/dotfiles PR #5484. This prototype removes fleet-specific dependencies and registration policy while preserving its fail-closed lifecycle.

## Prototype base

Based on upstream main `a8bd9fc7f4910e79be60ad2a466d9f7f0c249372`, as requested during preparation. The published `v2.0.0-beta.81` tag is available and resolves to `e73c66857553a5abe045e1a66b5512cf7d39ef2e`; main was deliberately selected instead of that tag. Both the checked-out package and installed fleet package identify as beta.81. The prototype uses main's resource/provider collection conventions and `effect/http` modules. It does not introduce a fleet library or a dependency on this fork into #5484.

Compared with the tag, main changes provider lifecycle's engine-supplied service from `InstanceId` to `ResourceContext`, adds `DeleteInProgress`, and refactors provider lookup/resource predicates. The constructor, collection, lifecycle inputs and adoption marker APIs used here remain compatible; Stack/Stage/Input/AdoptPolicy files have no relevant API changes. Postgres lock changes in the inspected diff are error-construction refactors, not remote-resource locking.

## Resource semantics

- `Notion.AccessAssertion` is local assertion state, not ownership of a remote object. Initial read verifies first, then local registration occurs. Every diff re-verifies cached assertions; read alone cannot protect noop plans.
- Verification checks integration identity (`users/me`), database and data-source IDs, data-source parent and database membership, stable property IDs/types, and query permission. The query uses an impossible creation interval and returns no rows. State stores only explicit IDs and required property metadata.
- `Notion.SchemaOwnership` binds an existing source, with `adopt: true` and native `Unowned` handling. The engine's adoption policy still applies. The provider never creates a missing database or source.
- Ownership is additive. It can add missing owned fields and missing select/multi-select/status options. Existing options are retained by ID; no existing field configuration is overwritten beyond additive options.
- Recorded field ID/type replacement is refused. Name/ID collisions and duplicate owned names are refused. Removing an owned declaration updates local ownership only; remote fields/options remain. Destroy is remote-noop.
- Mutations need explicit `writer: { stack, stage }`, matched against current stack/stage. No writer means observe-only, and pending additions fail during planning. This is authorization, not locking. Deployers must serialize every writer to the same remote data source externally.
- Every PATCH is followed by live verification of planned additions, pre-write option IDs, and unmanaged property IDs/types. A metadata-only receipt records timestamps, binding IDs, stage, additions and verification results. Tokens, API error bodies and row content are excluded. Post-write failure is surfaced; automatic rollback is deliberately not attempted because it could delete concurrent human changes.

## API surface

```typescript
import * as Notion from "alchemy/Notion";

// Stack provider layer: Notion.providers().
// Supply NOTION_TOKEN through Effect Config, not resource props.
const access = yield* Notion.AccessAssertion("access", {
  botId, databaseId, dataSourceId,
  properties: [{ id: "title", name: "Name", type: "title" }],
});
const schema = yield* Notion.SchemaOwnership("schema", {
  binding: { botId, databaseId, dataSourceId, properties: [] },
  adopt: true,
  owned: [{ name: "Published", type: "checkbox" }],
  writer: { stack: "ContentSchema", stage: "production" },
});
```

`Credentials` contains a redacted token and `fromEnv()` resolves `NOTION_TOKEN`. Tests/custom compositions inject Credentials and HttpClient directly. The minimal internal client pins `Notion-Version: 2025-09-03` and supports only GET users/me, GET databases/:id, GET data_sources/:id, POST data_sources/:id/query and PATCH data_sources/:id. It sanitizes transport/status/decode failures rather than retaining request/response causes. A future distilled Notion SDK could replace this client without changing resource props.

## Questions for maintainers

1. **Remote-resource locking:** inspected beta81 PostgresState uses an advisory lock keyed by stack/stage, not by remote resource. Different stacks/stages targeting one Notion source are not serialized by that lock. Should provider policy be injectable, or should Alchemy offer remote-resource locking? The prototype's writer guard cannot guarantee exclusivity or stop out-of-band human edits.
2. **Adoption forcing update:** beta81 performs reconcile after native adoption even if diff reports noop; CLI labels the operation adopted. The provider must make a no-delta reconcile strictly write-free. Is this intended engine behavior, and what adoption semantics should provider authors rely on?
3. **Postgres JSONB comparison:** JSONB reorders object keys. JSON.stringify comparison produced spurious diffs in the fleet, corrected with order-independent deep structural comparison. Should the SDK document a canonical diff comparator? Arrays intentionally remain order-sensitive.
4. **Peer range versus runtime compatibility:** beta72–79 peer ranges accepted Effect rc.118 although imports required by those releases were removed in rc.118. Can release compatibility gates exercise the entire supported peer range rather than relying on semver alone?
5. **Full-list option replacement:** Notion's option PATCH supplies a full options list and offers no conditional write/version token. Preserving observed IDs plus post-write checks detects some loss but cannot make the operation atomic against human or other-stack edits. Should upstream ship additive option writes with this documented limitation, require a policy service, or restrict the surface further?
6. **SDK ownership and credentials:** prefer a new `@distilled.cloud/notion` SDK or keep a minimal raw HttpClient? Should Notion join the existing profile/auth-provider system before publication? The draft uses Effect Config only and does not implement interactive authentication.
7. **Status options:** confirm supported API-version/account behavior for adding status options and whether a narrower resource API is preferable to the current generic property config. Mock coverage is not evidence of live Notion support for every requested config.
8. **Retain semantics and binding identity:** should retain-on-removal be provider default or exposed explicitly, and should a bound source change be rejected at diff rather than treated as a new adoption? The current port preserves fleet lifecycle behavior; it does not promise managed remote creation/replacement.

## Fleet independence and future swap

#5484 keeps its own providers, fleet manifest, credential bridge, explicit write opt-in, canonical writer registry and shared Postgres requirement. It continues verifying and deploying without this fork or an upstream package release. The upstream draft has generic synthetic tests, Config credentials and a designated-writer option; it has no fleet resource registry, package imports or backend-name gate.

Small future-swap changes to consider in #5484 (not applied):

- Keep resource props/output interfaces in a small fleet-independent module, so the manifest can satisfy upstream `AccessBinding` unchanged.
- Isolate the fleet's credential resolution into a layer supplying upstream `Credentials` with a redacted token; do not move the token into props/state.
- Express the canonical writer registry and Postgres/write-opt-in checks in a thin fleet policy composition, supplying generic writer props only after those stronger local checks pass.
- Use upstream-style resource/provider export names and keep consumer imports behind one fleet barrel to reduce the future import-only cutover.
- Preserve current resource type names/logical IDs and output shapes (`Notion.AccessAssertion`, `Notion.SchemaOwnership`) to avoid state churn; verify wire-state compatibility against the actually released upstream version before swapping.
- Keep the fleet's current stable comparator and post-write regression cases; compare upstream implementation/test behavior before removing local copies.

No suggested #5484 changes above were applied.

## Verification record

- `bun install --ignore-scripts` for an isolated toolchain was refused by the host disk guard (12 GiB free, below its 25 GiB install/build floor). No bypass or disk reclamation was performed; the full monorepo was not installed or built.
- The normal source CLI command `bun ../../packages/alchemy-test/bin/alchemy-test.ts test/Notion --tags unit --retry 0` could not load `@opentui/core`. To avoid changing the runner, a scratch entrypoint invokes the existing upstream `Runner.run` with its `PlainReporterLive` and BunServices, excluding only the CLI's unused TUI dependency. It imports the actual fork source and the actual test files, not translated tests or mocked Alchemy APIs.
- `bun run-notion.ts` from `tmp/alchemy-upstream/check` exercises all 29 mocked tests with the upstream runner. Initial run exposed the custom matcher's treatment of Unowned's non-enumerable brand; the adoption assertion now uses the engine's real `stripUnowned` API while independently checking `Unowned.is`.
- Isolated strict TypeScript checking uses the already installed TypeScript 7.0.2 and Effect 4.0.2, with the real published Alchemy beta81 declaration API. Scratch copies of the Notion source/tests change only relative core SDK imports to published `alchemy/*` imports and test paths; `alchemy-test` resolves to upstream's real source API. This is not a complete main-source/monorepo typecheck. It caught and corrected Effect 4's `Config.Redacted` capitalization and an overly broad schema service requirement.
- No formatters, full workspace typecheck, package build, generated API docs, CI, or live Notion calls were run. Mocked option tests are not a claim of live status-option API support.

### Final result

Fork branch: https://github.com/schickling-assistant/alchemy/tree/notion-provider-prototype

Pushed commit: `673d0b5937c57896c3435091d7b21c4cbf605fd4`.

Final isolated command (from `tmp/alchemy-upstream/check`): `node ../../../flakes/notion-iac/alchemy/node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — exit 0, no diagnostics, source and tests included.

Final source-runner command: `bun run-notion.ts` — exit 0; 29 passed, 0 failed, 0 skipped, across 2 files. The entrypoint uses upstream's actual headless runner as described above.

Push command: `git push notion-fork HEAD:refs/heads/notion-provider-prototype` — created the branch on the agent fork only. No upstream issue, PR, comment or push was made.
