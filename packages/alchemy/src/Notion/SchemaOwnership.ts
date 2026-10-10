import { isDeepStrictEqual } from 'node:util'
import { Unowned } from '../AdoptPolicy.ts'
import type { Input } from '../Input.ts'
import * as Provider from '../Provider.ts'
import { Resource } from '../Resource.ts'
import { StackName } from '../Stack.ts'
import { Stage } from '../Stage.ts'
import { Effect, Schema } from 'effect'
import { NotionDataSources } from './Client.ts'

import { AssertionFailed, verifyAssertion } from './AccessAssertion.ts'
import type { Providers } from './Providers.ts'
import { AccessBinding } from './AccessBinding.ts'

const Owned = Schema.Struct({ name: Schema.String, type: Schema.String, config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })
export const SchemaOwnershipProps = Schema.Struct({ binding: AccessBinding, owned: Schema.Array(Owned), adopt: Schema.Literal(true), writer: Schema.optional(Schema.Struct({ stack: Schema.String, stage: Schema.String })) })
export type SchemaOwnershipProps = typeof SchemaOwnershipProps.Type
export type OwnershipState = { readonly binding: AccessBinding; readonly owned: readonly { readonly id: string; readonly name: string; readonly type: string }[] }
export interface SchemaOwnership extends Resource<'Notion.SchemaOwnership', SchemaOwnershipProps, OwnershipState, never, Providers> {}
/**
 * Adopt an existing Notion data source and own only additive schema fields.
 * Never creates a database/data source, deletes fields, or replaces field IDs/types.
 * Removal retains remote fields; destruction only forgets local ownership.
 * Existing select/multi_select/status options are retained by ID when adding options.
 * Every PATCH is re-read and checked, with a sanitized metadata-only receipt.
 *
 * Native adoption also requires Alchemy's adoption policy (for example --adopt).
 * Omitting writer makes the resource observe-only: any pending mutation fails closed.
 * writer is an explicit authorization guard, NOT a distributed lock. Serialize all
 * writers to the same remote data source externally; Notion offers no conditional PATCH.
 *
 * @example
 * ```typescript
 * const schema = yield* Notion.SchemaOwnership("schema", {
 *   binding: { botId, databaseId, dataSourceId, properties: [] },
 *   adopt: true,
 *   owned: [{ name: "Published", type: "checkbox" }],
 *   writer: { stack: "ContentSchema", stage: "production" },
 * });
 * ```
 * @resource
 * @product Data Sources
 * @category Collaboration
 */
export const SchemaOwnership = Resource<SchemaOwnership>('Notion.SchemaOwnership')

const failure = (message: string) => new AssertionFailed({ message })
const safeApiError = (error: { readonly _tag: string; readonly status?: number }) => failure(error._tag === 'NotionApiError' ? `Notion schema ownership failed (HTTP ${error.status})` : 'Notion schema ownership failed')
const Options = Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.String, color: Schema.optional(Schema.String), description: Schema.optional(Schema.String), group: Schema.optional(Schema.String) }))
const ObservedOptions = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))

/** Explicit designated writer; callers must serialize all writers to a remote source. */
const requireMutationPermission = Effect.fn('Notion.SchemaOwnership.requireWriter')(function* (props: SchemaOwnershipProps) {
  const stage = yield* Stage
  const stack = yield* StackName
  if (props.writer === undefined || props.writer.stage !== stage || props.writer.stack !== stack) {
    return yield* failure('Notion schema mutation requires an explicit designated writer matching the current stack/stage')
  }
})

const inspect = Effect.fn('Notion.SchemaOwnership.inspect')(function* (props: SchemaOwnershipProps, output?: OwnershipState) {
  yield* verifyAssertion(props.binding)
  const source = yield* NotionDataSources.retrieve({ dataSourceId: props.binding.dataSourceId }).pipe(Effect.mapError(safeApiError))
  const observedProperties = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String })))(source.properties).pipe(Effect.mapError(() => failure('Invalid observed property metadata')))
  const observedOptions: Record<string, readonly { readonly id: string; readonly name: string }[]> = {}
  for (const property of Object.values(observedProperties)) {
    if (!['select', 'multi_select', 'status'].includes(property.type)) continue
    const fields = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(source.properties[property.name]).pipe(Effect.mapError(() => failure('Invalid observed option property')))
    const config = yield* Schema.decodeUnknownEffect(Schema.Struct({ options: Schema.optional(ObservedOptions) }))(fields[property.type]).pipe(Effect.mapError(() => failure('Invalid observed option IDs')))
    observedOptions[property.id] = config.options ?? []
  }
  const delta: Record<string, unknown> = {}
  const owned: { id: string; name: string; type: string }[] = []
  const names = new Set<string>()
  for (const requested of props.owned) {
    const normalizedName = requested.name.trim().toLowerCase()
    if (names.has(normalizedName)) return yield* failure('Duplicate owned property name')
    names.add(normalizedName)
    const raw = source.properties[requested.name]
    const recorded = output?.owned.find(p => p.name === requested.name)
    if (raw === undefined) {
      if (recorded !== undefined) return yield* failure('Recorded owned property was removed; replacement is refused')
      if (Object.values(observedProperties).some(property => property.id === requested.name || property.name.trim().toLowerCase() === normalizedName)) {
        return yield* failure('Owned property addition collides with an observed property ID or name')
      }
      delta[requested.name] = { type: requested.type, [requested.type]: requested.config ?? {} }
      continue
    }
    const actual = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String }))(raw).pipe(Effect.mapError(() => failure('Invalid observed owned property')))
    if (actual.type !== requested.type) return yield* failure('Owned property type mismatch; replacement is refused')
    if (recorded !== undefined && actual.id !== recorded.id) return yield* failure('Owned property stable ID changed; replacement is refused')
    owned.push({ id: actual.id, name: requested.name, type: requested.type })
    if (requested.config !== undefined) {
      // Existing configurations are never overwritten. Only option additions are supported.
      if (!['select', 'multi_select', 'status'].includes(requested.type) || Object.keys(requested.config).some(k => k !== 'options')) {
        return yield* failure('Existing owned property config supports additive options only')
      }
      const wanted = yield* Schema.decodeUnknownEffect(Options)(requested.config.options ?? []).pipe(Effect.mapError(() => failure('Invalid owned option configuration')))
      const observed = observedOptions[actual.id] ?? []
      const missing = wanted.filter(option => !observed.some(existing => existing.name.trim().toLowerCase() === option.name.trim().toLowerCase()))
      if (missing.length > 0) {
        // Retaining by ID leaves human name/color/description/status-group untouched.
        const retain = observed.map(option => ({ id: option.id }))
        delta[actual.id] = { [requested.type]: { options: [...retain, ...missing.map(({ id: _id, ...option }) => option)] } }
      }
    }
  }
  yield* Effect.logInfo(`Notion schema verified: ${props.binding.dataSourceId}; pending property PATCH entries: ${Object.keys(delta).length}`)
  return { state: { binding: props.binding, owned } satisfies OwnershipState, delta, properties: observedProperties, options: observedOptions }
})

const removalOnly = (news: SchemaOwnershipProps, olds: SchemaOwnershipProps): boolean =>
  isDeepStrictEqual(news.binding, olds.binding) && news.owned.length < olds.owned.length && news.owned.every(p => olds.owned.some(old => isDeepStrictEqual(old, p)))

export const ownershipLifecycle = {
  read: Effect.fn('Notion.SchemaOwnership.read')(function* ({ olds, output }: { olds: SchemaOwnershipProps; output: OwnershipState | undefined }) {
    const props = yield* Schema.decodeUnknownEffect(SchemaOwnershipProps)(olds).pipe(Effect.mapError(() => failure('Explicit adoption and UUID binding are required')))
    const observed = yield* inspect(props, output)
    if (Object.keys(observed.delta).length > 0) yield* requireMutationPermission(props)
    return output === undefined ? Unowned(observed.state) : observed.state
  }),
  diff: Effect.fn('Notion.SchemaOwnership.diff')(function* ({ news, olds, output }: { news: Input<SchemaOwnershipProps>; olds: SchemaOwnershipProps; output: OwnershipState | undefined }) {
    const props = yield* Schema.decodeUnknownEffect(SchemaOwnershipProps)(news).pipe(Effect.mapError(() => failure('Explicit adoption and UUID binding are required')))
    const observed = yield* inspect(props, output)
    if (removalOnly(props, olds)) return { action: 'update' as const }
    if (Object.keys(observed.delta).length > 0) {
      yield* requireMutationPermission(props)
      return { action: 'update' as const }
    }
    if (output !== undefined && !isDeepStrictEqual(observed.state, output)) return { action: 'update' as const }
    return { action: 'noop' as const }
  }),
  reconcile: Effect.fn('Notion.SchemaOwnership.reconcile')(function* ({ news, olds, output }: { news: SchemaOwnershipProps; olds: SchemaOwnershipProps | undefined; output: OwnershipState | undefined }) {
    const observed = yield* inspect(news, output)
    if (olds !== undefined && output !== undefined && removalOnly(news, olds)) return observed.state
    if (Object.keys(observed.delta).length === 0) return observed.state
    yield* requireMutationPermission(news)
    const stage = yield* Stage
    const startedAt = yield* Effect.sync(() => new Date().toISOString())
    yield* Effect.logInfo(`Notion schema PATCH: ${news.binding.dataSourceId}`)
    yield* NotionDataSources.update({ dataSourceId: news.binding.dataSourceId, properties: observed.delta }).pipe(Effect.mapError(safeApiError))
    const postResult = yield* inspect(news, output).pipe(Effect.result)
    const completedAt = yield* Effect.sync(() => new Date().toISOString())
    const bindingIds = { botId: news.binding.botId, databaseId: news.binding.databaseId, dataSourceId: news.binding.dataSourceId }
    if (postResult._tag === 'Failure') {
      yield* Effect.logInfo({ event: 'Notion.SchemaWriteReceipt', binding: bindingIds, stage, startedAt, completedAt, propertiesAdded: [], optionsAdded: [], checks: { optionIdsRetained: 'unverified', unmanagedPropertiesUnchanged: 'unverified', postRead: 'failed' } })
      return yield* postResult.failure
    }
    const post = postResult.success
    const optionIdsRetained = Object.entries(observed.options).every(([id, options]) => options.every(option => post.options[id]?.some(actual => actual.id === option.id)))
    const unmanagedPropertiesUnchanged = Object.values(observed.properties).filter(property => !news.owned.some(owned => owned.name === property.name)).every(property => post.properties[property.name]?.id === property.id && post.properties[property.name]?.type === property.type)
    const propertiesAdded = Object.values(post.properties).filter(property => news.owned.some(owned => owned.name === property.name) && observed.properties[property.name] === undefined)
    const optionsAdded = Object.entries(post.options).flatMap(([propertyId, options]) => options.filter(option => !observed.options[propertyId]?.some(old => old.id === option.id)).map(option => ({ propertyId, ...option })))
    const plannedAdditionsVerified = Object.keys(post.delta).length === 0
    yield* Effect.logInfo({ event: 'Notion.SchemaWriteReceipt', binding: bindingIds, stage, startedAt, completedAt, propertiesAdded, optionsAdded, checks: { optionIdsRetained, unmanagedPropertiesUnchanged, plannedAdditionsVerified } })
    if (!optionIdsRetained || !unmanagedPropertiesUnchanged || !plannedAdditionsVerified) return yield* failure('Notion schema post-write safety check failed; stop and inspect the sanitized write receipt')
    return post.state
  }),
  delete: Effect.fn('Notion.SchemaOwnership.delete')(function* () {}),
}
export const SchemaOwnershipProvider = () => Provider.succeed(SchemaOwnership, ownershipLifecycle)
