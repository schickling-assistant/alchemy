import { describe, expect, it } from 'alchemy-test'
import { Effect, Layer, Logger, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { Unowned, stripUnowned } from '../../src/AdoptPolicy.ts'
import { Stack } from '../../src/Stack.ts'
import { Stage } from '../../src/Stage.ts'
import { Credentials } from '../../src/Notion/Credentials.ts'
import { ownershipLifecycle, type SchemaOwnershipProps, type OwnershipState } from '../../src/Notion/SchemaOwnership.ts'
import type { AccessBinding } from '../../src/Notion/AccessBinding.ts'

const binding: AccessBinding = {
  botId: '11111111-1111-4111-8111-111111111111',
  databaseId: '22222222-2222-4222-8222-222222222222',
  dataSourceId: '33333333-3333-4333-8333-333333333333',
  properties: [
    { id: 'title', name: 'Test title', type: 'title' },
    { id: 'workflow-id', name: 'Workflow', type: 'status' },
  ],
}
const sentinel = 'ownership-test-credential'
const props: SchemaOwnershipProps = { binding, owned: [{ name: 'Workflow', type: 'status' }], adopt: true, writer: { stack: 'NotionSchema', stage: 'schema-owner' } }
const stored: OwnershipState = { binding, owned: [{ id: 'workflow-id', name: 'Workflow', type: 'status' }] }

type Property = { id: string; name: string; type: string; [key: string]: unknown }
const fixture = (opts: { status?: number; property?: Property; stage?: string; stack?: string; loseOptionAfterPatch?: boolean; mutateHumanAfterPatch?: 'id' | 'type' } = {}) => {
  const requests: { method: string; body: unknown }[] = []
  const logs: unknown[] = []
  const properties: Record<string, Property> = Object.fromEntries(binding.properties.map(p => [p.name, { ...p, [p.type]: {} }]))
  if (opts.property) properties[opts.property.name] = opts.property
  properties.Human = { id: 'human-id', name: 'Human', type: 'rich_text', rich_text: {} }
  const source = () => ({ object: 'data_source', id: binding.dataSourceId, title: [], description: [], icon: null, cover: null, parent: { type: 'database_id', database_id: binding.databaseId }, database_parent: { type: 'workspace', workspace: true }, properties, is_inline: false, in_trash: false, url: 'https://www.notion.so/source', public_url: null, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-01-01T00:00:00Z', created_by: { object: 'user', id: binding.botId }, last_edited_by: { object: 'user', id: binding.botId } })
  const layer = Layer.mergeAll(
    Layer.succeed(Credentials, { token: Redacted.make(sentinel) }),
    Layer.succeed(Stage, opts.stage ?? 'schema-owner'),
    Layer.succeed(Stack, { name: opts.stack ?? 'NotionSchema', stage: opts.stage ?? 'schema-owner', resources: {}, bindings: {}, actions: {} }),
    Logger.layer([Logger.make(options => { logs.push(options.message) })]),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(request => Effect.sync(() => {
      const body = request.body._tag === 'Uint8Array' ? JSON.parse(new TextDecoder().decode(request.body.body)) as { properties: Record<string, { type?: string; [key: string]: unknown }> } : undefined
      requests.push({ method: request.method, body })
      const path = new URL(request.url).pathname
      let response: unknown
      let status = 200
      if (path.endsWith('/users/me')) response = { object: 'user', id: binding.botId }
      else if (opts.status) { status = opts.status; response = { object: 'error', status, code: status === 401 ? 'unauthorized' : status === 403 ? 'restricted_resource' : 'object_not_found', message: sentinel } }
      else if (path.includes('/databases/')) response = { object: 'database', id: binding.databaseId, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-01-01T00:00:00Z', title: [], description: [], icon: null, cover: null, parent: { type: 'workspace', workspace: true }, url: 'https://www.notion.so/database', in_trash: false, is_inline: false, public_url: null, data_sources: [{ id: binding.dataSourceId, name: 'source' }] }
      else if (path.endsWith('/query')) response = { object: 'list', results: [], next_cursor: null, has_more: false }
      else {
        if (request.method === 'PATCH' && body) {
          for (const [key, change] of Object.entries(body.properties)) {
            const existing = Object.values(properties).find(p => p.id === key)
            if (existing) {
              const configSchema = Schema.Struct({ options: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })
              const oldConfig = Schema.decodeUnknownSync(configSchema)(existing[existing.type])
              const next = Schema.decodeUnknownSync(configSchema)(change[existing.type])
              existing[existing.type] = { options: next.options.filter(option => !opts.loseOptionAfterPatch || option.id !== 'human-option').map(option => option.id === undefined ? { ...option, id: `option-${option.name}` } : oldConfig.options.find(old => old.id === option.id) ?? option) }
            }
            else properties[key] = { ...change, id: `new-${key}`, name: key, type: change.type! }
          }
          if (opts.mutateHumanAfterPatch === 'id') properties.Human.id = 'replaced-human'
          if (opts.mutateHumanAfterPatch === 'type') properties.Human.type = 'number'
        }
        response = source()
      }
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }))
    }))),
  )
  return { layer, requests, properties, logs }
}

describe('Notion.SchemaOwnership', { tags: ['unit', 'local'] }, () => {
  it.each([401, 403, 404])('refuses HTTP %s roots without non-GET requests', async status => {
    const f = fixture({ status })
    const result = await Effect.runPromise(ownershipLifecycle.read({ olds: props, output: undefined }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(f.requests.map(r => r.method)).toEqual(['GET', 'GET'])
  })
  it('adopts existing field natively, records stable ID, and never PATCHes', async () => {
    const f = fixture()
    const output = await Effect.runPromise(ownershipLifecycle.read({ olds: props, output: undefined }).pipe(Effect.provide(f.layer)))
    expect(Unowned.is(output)).toBe(true)
    expect(stripUnowned(output)).toEqual(stored)
    const diff = await Effect.runPromise(ownershipLifecycle.diff({ news: props, olds: props, output }).pipe(Effect.provide(f.layer)))
    expect(diff).toEqual({ action: 'noop' })
    expect(f.requests.some(r => r.method === 'PATCH')).toBe(false)
    expect(JSON.stringify(output)).not.toContain(sentinel)
    expect(JSON.stringify(f.logs)).not.toContain(sentinel)
  })
  it('adds missing owned field with only owned delta', async () => {
    const f = fixture()
    const news = { ...props, owned: [{ name: 'Added', type: 'rich_text' }] }
    const diff = await Effect.runPromise(ownershipLifecycle.diff({ news, olds: news, output: undefined }).pipe(Effect.provide(f.layer)))
    expect(diff).toEqual({ action: 'update' })
    const output = await Effect.runPromise(ownershipLifecycle.reconcile({ news, olds: undefined, output: undefined }).pipe(Effect.provide(f.layer)))
    expect(f.requests.filter(r => r.method === 'PATCH')).toEqual([{ method: 'PATCH', body: { properties: { Added: { type: 'rich_text', rich_text: {} } } } }])
    expect(output.owned).toEqual([{ id: 'new-Added', name: 'Added', type: 'rich_text' }])
    expect(f.properties.Human).toEqual({ id: 'human-id', name: 'Human', type: 'rich_text', rich_text: {} })
    expect(f.logs.flat()).toContainEqual(expect.objectContaining({
      event: 'Notion.SchemaWriteReceipt',
      binding: { botId: binding.botId, databaseId: binding.databaseId, dataSourceId: binding.dataSourceId },
      stage: 'schema-owner',
      propertiesAdded: [{ id: 'new-Added', name: 'Added', type: 'rich_text' }],
      optionsAdded: [],
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      checks: { optionIdsRetained: true, unmanagedPropertiesUnchanged: true, plannedAdditionsVerified: true },
    }))
    expect(JSON.stringify(f.logs)).not.toContain(sentinel)
    expect(JSON.stringify(output)).not.toContain('startedAt')
  })
  it.each(['select', 'multi_select', 'status'])('adds only missing %s options and preserves human options unchanged', async type => {
    const human = { id: 'human-option', name: 'Human choice', color: 'blue' }
    const f = fixture({ property: { id: 'choice', name: 'Choice', type, [type]: { options: [human] } } })
    const news = { ...props, owned: [{ name: 'Choice', type, config: { options: [{ name: 'New choice', color: 'red' }] } }] }
    await Effect.runPromise(ownershipLifecycle.reconcile({ news, olds: undefined, output: undefined }).pipe(Effect.provide(f.layer)))
    expect(f.requests.filter(r => r.method === 'PATCH')).toEqual([{ method: 'PATCH', body: { properties: { choice: { [type]: { options: [{ id: human.id }, { name: 'New choice', color: 'red' }] } } } } }])
    expect(f.properties.Choice[type]).toEqual({ options: [human, { id: 'option-New choice', name: 'New choice', color: 'red' }] })
    expect(f.logs.flat()).toContainEqual(expect.objectContaining({ event: 'Notion.SchemaWriteReceipt', optionsAdded: [{ propertyId: 'choice', id: 'option-New choice', name: 'New choice' }], checks: { optionIdsRetained: true, unmanagedPropertiesUnchanged: true, plannedAdditionsVerified: true } }))
  })
  it.each([undefined, { stack: 'OtherStack', stage: 'schema-owner' }, { stack: 'NotionSchema', stage: 'other-stage' }])('fails closed at plan without a matching explicit writer (%j)', async writer => {
    const f = fixture()
    const news = { ...props, writer, owned: [{ name: 'Added', type: 'rich_text' }] }
    const result = await Effect.runPromise(ownershipLifecycle.diff({ news, olds: news, output: undefined }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.some(r => r.method === 'PATCH')).toBe(false)
  })
  it.each(['type', 'id'])('refuses owned %s replacement without PATCH', async kind => {
    // Ownership is separate from the access baseline so this exercises ownership checks.
    const property = { id: kind === 'id' ? 'replacement' : 'original', name: 'Owned', type: kind === 'type' ? 'number' : 'rich_text', rich_text: {}, number: {} }
    const f = fixture({ property })
    const news = { ...props, owned: [{ name: 'Owned', type: 'rich_text' }] }
    const output = { binding, owned: [{ id: 'original', name: 'Owned', type: 'rich_text' }] }
    const result = await Effect.runPromise(ownershipLifecycle.diff({ news, olds: news, output }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.some(r => r.method === 'PATCH')).toBe(false)
  })
  it('removal re-verifies in diff and reconcile, while destroy sends no requests', async () => {
    const f = fixture()
    const news = { ...props, owned: [] }
    await Effect.runPromise(ownershipLifecycle.diff({ news, olds: props, output: stored }).pipe(Effect.provide(f.layer)))
    const output = await Effect.runPromise(ownershipLifecycle.reconcile({ news, olds: props, output: stored }).pipe(Effect.provide(f.layer)))
    const beforeDestroy = f.requests.length
    await Effect.runPromise(ownershipLifecycle.delete())
    expect(f.requests).toHaveLength(beforeDestroy)
    expect(output.owned).toEqual([])
    expect(f.requests.map(r => r.method)).toEqual(['GET', 'GET', 'GET', 'POST', 'GET', 'GET', 'GET', 'GET', 'POST', 'GET'])
    expect(f.requests.some(r => r.method === 'PATCH' || r.method === 'DELETE')).toBe(false)
  })
  it.each(['abcd', ' human '])('refuses owned additions colliding with observed IDs/names (%s)', async name => {
    const f = fixture()
    f.properties.Human.id = 'abcd'
    const news = { ...props, owned: [{ name, type: 'number' }] }
    const result = await Effect.runPromise(ownershipLifecycle.reconcile({ news, olds: undefined, output: undefined }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.some(r => r.method === 'PATCH')).toBe(false)
  })
  it.each([{ stage: 'other-stage' }, { stack: 'OtherStack' }])('refuses writes outside the configured writer context (%j)', async context => {
    const f = fixture({ ...context })
    const news = { ...props, owned: [{ name: 'Added', type: 'rich_text' }] }
    const result = await Effect.runPromise(ownershipLifecycle.diff({ news, olds: news, output: undefined }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.some(r => r.method === 'PATCH')).toBe(false)
  })
  it.each(['diff', 'reconcile'])('removal fails closed on revoked access in %s', async hook => {
    const f = fixture({ status: 403 })
    const news = { ...props, owned: [] }
    const effect = hook === 'diff'
      ? ownershipLifecycle.diff({ news, olds: props, output: stored }).pipe(Effect.asVoid)
      : ownershipLifecycle.reconcile({ news, olds: props, output: stored }).pipe(Effect.asVoid)
    const result = await Effect.runPromise(effect.pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.map(r => r.method)).toEqual(['GET', 'GET'])
  })
  it('fails loudly and emits failed receipt when a pre-write option ID disappears', async () => {
    const f = fixture({ loseOptionAfterPatch: true, property: { id: 'choice', name: 'Choice', type: 'select', select: { options: [{ id: 'human-option', name: 'Human choice' }] } } })
    const news = { ...props, owned: [{ name: 'Choice', type: 'select', config: { options: [{ name: 'New choice' }] } }] }
    const result = await Effect.runPromise(ownershipLifecycle.reconcile({ news, olds: undefined, output: undefined }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.filter(r => r.method === 'PATCH')).toHaveLength(1)
    expect(f.logs.flat()).toContainEqual(expect.objectContaining({ event: 'Notion.SchemaWriteReceipt', checks: { optionIdsRetained: false, unmanagedPropertiesUnchanged: true, plannedAdditionsVerified: true } }))
    expect(JSON.stringify([result, f.logs])).not.toContain(sentinel)
  })
  it.each(['id', 'type'] as const)('fails loudly when an unmanaged property %s changed after PATCH', async mutateHumanAfterPatch => {
    const f = fixture({ mutateHumanAfterPatch })
    const news = { ...props, owned: [{ name: 'Added', type: 'rich_text' }] }
    const result = await Effect.runPromise(ownershipLifecycle.reconcile({ news, olds: undefined, output: undefined }).pipe(Effect.provide(f.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(f.requests.filter(r => r.method === 'PATCH')).toHaveLength(1)
    expect(f.logs.flat()).toContainEqual(expect.objectContaining({ event: 'Notion.SchemaWriteReceipt', checks: { optionIdsRetained: true, unmanagedPropertiesUnchanged: false, plannedAdditionsVerified: true } }))
  })
  it('treats persisted object key reordering as noop', async () => {
    const f = fixture()
    const output: OwnershipState = {
      owned: [{ type: 'status', name: 'Workflow', id: 'workflow-id' }],
      binding: { properties: binding.properties.map(p => ({ type: p.type, name: p.name, id: p.id })), dataSourceId: binding.dataSourceId, databaseId: binding.databaseId, botId: binding.botId },
    }
    const diff = await Effect.runPromise(ownershipLifecycle.diff({ news: props, olds: props, output }).pipe(Effect.provide(f.layer)))
    expect(diff).toEqual({ action: 'noop' })
    expect(f.requests.some(r => r.method === 'PATCH')).toBe(false)
  })
})
