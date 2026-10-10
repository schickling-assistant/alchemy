import { Effect, Schema } from "effect";
import type { AccessBinding } from "./AccessBinding.ts";
import { NotionDatabases, NotionDataSources, NotionUsers } from "./Client.ts";

/** Live infrastructure differs from the declared integration/resource binding. */
export class AccessMismatch extends Schema.TaggedError<AccessMismatch>()("AccessMismatch", {
  message: Schema.String,
}) {}

const Property = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String });
const uuidEqual = ({ a, b }: { readonly a: string; readonly b: string }): boolean =>
  a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();

/** Compare stable IDs as well as names: replacing a same-named property is drift. */
export const verifySchema = Effect.fn("Notion.verifySchema")(function* (
  binding: AccessBinding,
  properties: Readonly<Record<string, unknown>>,
) {
  const observed = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Property))(
    properties,
  ).pipe(
    Effect.mapError(() => new AccessMismatch({ message: "Invalid Notion property metadata" })),
  );
  for (const required of binding.properties) {
    const actual = observed[required.name];
    if (
      actual === undefined || actual.id !== required.id ||
      actual.name !== required.name || actual.type !== required.type
    ) {
      return yield* new AccessMismatch({
        message: `Required property ${required.name} has drifted on ${binding.dataSourceId}`,
      });
    }
  }
});

/** Live acceptance, not cached IaC state. No row content or token enters outputs. */
export const verifyAccess = Effect.fn("Notion.verifyAccess")(function* (binding: AccessBinding) {
  const identity = yield* NotionUsers.me();
  if (!uuidEqual({ a: identity.id, b: binding.botId })) {
    return yield* new AccessMismatch({ message: "Wrong Notion integration identity" });
  }
  const database = yield* NotionDatabases.retrieve({ databaseId: binding.databaseId });
  const dataSource = yield* NotionDataSources.retrieve({ dataSourceId: binding.dataSourceId });
  if (
    database.in_trash || dataSource.in_trash ||
    !uuidEqual({ a: database.id, b: binding.databaseId }) ||
    !uuidEqual({ a: dataSource.id, b: binding.dataSourceId }) ||
    !uuidEqual({ a: dataSource.parent.database_id, b: binding.databaseId }) ||
    !database.data_sources.some((source) => uuidEqual({ a: source.id, b: binding.dataSourceId }))
  ) {
    return yield* new AccessMismatch({
      message: `Database/data-source binding has drifted: ${binding.databaseId}`,
    });
  }
  yield* verifySchema(binding, dataSource.properties);
  // An impossible creation interval exercises query authorization without fetching notes.
  const query = yield* NotionDatabases.query({
    dataSourceId: binding.dataSourceId,
    pageSize: 1,
    filter: {
      and: [
        { timestamp: "created_time", created_time: { after: "2026-01-02T00:00:00Z" } },
        { timestamp: "created_time", created_time: { before: "2026-01-01T00:00:00Z" } },
      ],
    },
  });
  if (query.results.length !== 0) {
    return yield* new AccessMismatch({
      message: "Notion returned rows for an impossible interval; stop without exposing content",
    });
  }
  return {
    botId: binding.botId,
    databaseId: binding.databaseId,
    dataSourceId: binding.dataSourceId,
    properties: binding.properties,
    queryVerified: true as const,
  };
});
