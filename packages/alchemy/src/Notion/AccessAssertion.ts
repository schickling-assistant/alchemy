import * as Provider from '../Provider.ts'
import type { Input } from '../Input.ts'
import { Resource } from '../Resource.ts'
import { Effect, Schema } from 'effect'

import { AccessBinding } from './AccessBinding.ts'
import { verifyAccess } from './Verify.ts'
import type { Providers } from './Providers.ts'

/** Only safe, local metadata is allowed across Alchemy's state/log boundary. */
export class AssertionFailed extends Schema.TaggedError<AssertionFailed>()('AssertionFailed', {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export const verifyAssertion = Effect.fn('Notion.AccessAssertion.verify')(function* (binding: AccessBinding) {
  const verified = yield* verifyAccess(binding).pipe(
    Effect.mapError((error) => {
      const status = error._tag === 'NotionApiError' ? error.status : undefined
      return new AssertionFailed({
        message: status === undefined
          ? 'Notion access assertion failed (identity, schema, credential or transport mismatch)'
          : `Notion access assertion failed (HTTP ${status}); explicit bindings are never created`,
        ...(status === undefined ? {} : { status }),
      })
    }),
  )
  yield* Effect.logInfo(`Notion access verified: ${binding.databaseId}`)
  return {
    botId: verified.botId,
    databaseId: verified.databaseId,
    dataSourceId: verified.dataSourceId,
    properties: verified.properties,
  }
})


export interface AccessAssertion extends Resource<
  'Notion.AccessAssertion', AccessBinding, AccessBinding, never, Providers
> {}
/**
 * Verify an existing integration/database/data-source binding on every plan.
 * Checks integration identity, parent binding, stable property IDs/types and query
 * permission. Query uses an impossible interval: no row content is persisted.
 * Missing/inaccessible resources fail closed and are never created automatically.
 * Destruction removes only the local assertion, leaving Notion untouched.
 *
 * @example
 * ```typescript
 * const access = yield* Notion.AccessAssertion("access", {
 *   botId, databaseId, dataSourceId,
 *   properties: [{ id: "title", name: "Name", type: "title" }],
 * });
 * ```
 * @resource
 * @product Data Sources
 * @category Collaboration
 */
export const AccessAssertion = Resource<AccessAssertion>('Notion.AccessAssertion')

export const assertionLifecycle = {
  // Alchemy calls read on the initial plan. The assertion itself has no remote
  // existence/ownership: verify first, then register a local assertion (create).
  read: Effect.fn('Notion.AccessAssertion.read')(function* ({ olds, output }: {
    olds: AccessBinding; output: AccessBinding | undefined
  }) {
    const verified = yield* verifyAssertion(olds)
    return output === undefined ? undefined : verified
  }),
  // Existing resources use diff during EVERY plan, including noop deploys;
  // read alone is insufficient because normal plans do not refresh cached state.
  diff: Effect.fn('Notion.AccessAssertion.diff')(function* ({ news }: { news: Input<AccessBinding> }) {
    const binding = yield* Schema.decodeUnknownEffect(AccessBinding)(news).pipe(
      Effect.mapError(() => new AssertionFailed({ message: 'Access assertions require explicit UUID bindings' })),
    )
    yield* verifyAssertion(binding)
    return undefined
  }),
  reconcile: Effect.fn('Notion.AccessAssertion.reconcile')(function* ({ news }: { news: AccessBinding }) {
    return yield* verifyAssertion(news)
  }),
  // Retain all Notion resources. Only Alchemy's local assertion is removed.
  delete: Effect.fn('Notion.AccessAssertion.delete')(function* () {}),
}

export const AccessAssertionProvider = () => Provider.succeed(AccessAssertion, assertionLifecycle)
