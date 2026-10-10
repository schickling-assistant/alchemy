import { describe, expect, it } from 'alchemy-test'
import { Effect, Layer, Redacted } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { Credentials } from '../../src/Notion/Credentials.ts'

import { assertionLifecycle } from '../../src/Notion/AccessAssertion.ts'
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
const sentinel = 'credential-sentinel-never-persist'
const rowSentinel = 'row-body-never-persist'

const mockLayer = (status?: number, wrongIdentity = false) => {
  const methods: string[] = []
  const layer = Layer.merge(
    Layer.succeed(Credentials, { token: Redacted.make(sentinel) }),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => {
      methods.push(request.method)
      const path = new URL(request.url).pathname
      let body: unknown
      let responseStatus = 200
      if (path.endsWith('/users/me')) {
        body = { object: 'user', id: wrongIdentity ? crypto.randomUUID() : binding.botId }
      } else if (status !== undefined) {
        responseStatus = status
        body = { object: 'error', status, code: status === 404 ? 'object_not_found' : status === 401 ? 'unauthorized' : 'restricted_resource', message: sentinel }
      } else if (path.includes('/query')) {
        body = { object: 'list', results: [], next_cursor: null, has_more: false }
      } else if (path.includes('/databases/')) {
        body = { object: 'database', id: binding.databaseId, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-01-01T00:00:00Z', title: [], description: [], icon: null, cover: null, parent: { type: 'workspace', workspace: true }, url: 'https://www.notion.so/database', in_trash: false, is_inline: false, public_url: null, data_sources: [{ id: binding.dataSourceId, name: rowSentinel }] }
      } else {
        body = { object: 'data_source', id: binding.dataSourceId, title: [], description: [], icon: null, cover: null, parent: { type: 'database_id', database_id: binding.databaseId }, database_parent: { type: 'workspace', workspace: true }, properties: Object.fromEntries(binding.properties.map(p => [p.name, { ...p, [p.type]: {} }])), is_inline: false, in_trash: false, url: 'https://www.notion.so/data-source', public_url: null, created_time: '2026-01-01T00:00:00Z', created_by: { object: 'user', id: binding.botId }, last_edited_time: '2026-01-01T00:00:00Z', last_edited_by: { object: 'user', id: binding.botId } }
      }
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: responseStatus, headers: { 'content-type': 'application/json' } }))
    }))),
  )
  return { layer, methods }
}

describe('Notion.AccessAssertion', { tags: ['unit', 'local'] }, () => {
  it.each([401, 403, 404])('fails closed on HTTP %s with no non-GET requests', async (status) => {
    const mock = mockLayer(status)
    const props = { ...binding, databaseId: crypto.randomUUID() }
    const result = await Effect.runPromise(assertionLifecycle.read({ olds: props, output: undefined }).pipe(Effect.provide(mock.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure.status).toBe(status)
      expect(JSON.stringify(result.failure)).not.toContain(sentinel)
    }
    expect(mock.methods).toEqual(['GET', 'GET'])
  })

  it('sanitizes assertion identity mismatches', async () => {
    const mock = mockLayer(undefined, true)
    const result = await Effect.runPromise(assertionLifecycle.diff({ news: binding }).pipe(Effect.provide(mock.layer), Effect.result))
    expect(result._tag).toBe('Failure')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(mock.methods).toEqual(['GET'])
  })

  it('re-verifies cached assertions and outputs only IDs and property metadata', async () => {
    const mock = mockLayer()
    const output = await Effect.runPromise(assertionLifecycle.reconcile({ news: binding }).pipe(Effect.provide(mock.layer)))
    expect(output).toEqual(binding)
    expect(JSON.stringify(output)).not.toContain(sentinel)
    expect(JSON.stringify(output)).not.toContain(rowSentinel)
    await Effect.runPromise(assertionLifecycle.diff({ news: binding }).pipe(Effect.provide(mock.layer)))
    await Effect.runPromise(assertionLifecycle.read({ olds: binding, output }).pipe(Effect.provide(mock.layer)))
    expect(mock.methods).toEqual(Array.from({ length: 3 }, () => ['GET', 'GET', 'GET', 'POST']).flat())
    // POST is only the impossible-interval query used to verify query access.
    await Effect.runPromise(assertionLifecycle.delete())
    expect(mock.methods).toHaveLength(12)
  })
})
