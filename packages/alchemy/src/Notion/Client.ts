import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Credentials } from "./Credentials.ts";

/** Safe error metadata only: never retain HTTP bodies, headers or original causes. */
export class NotionApiError extends Schema.TaggedError<NotionApiError>()(
  "NotionApiError",
  { message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

const Identity = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
});
const Database = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  in_trash: Schema.Boolean,
  data_sources: Schema.Array(
    Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
  ),
});
const DataSource = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  in_trash: Schema.Boolean,
  parent: Schema.Struct({
    type: Schema.Literal("database_id"),
    database_id: Schema.String.check(Schema.isUUID()),
  }),
  properties: Schema.Record(Schema.String, Schema.Unknown),
});
// Only identity metadata is decoded from query results, never page content.
const Query = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
  ),
});

/**
 * This intentionally small client targets https://api.notion.com/v1 only and
 * pins Notion-Version: 2025-09-03 (database/data-source split). Callers provide
 * Credentials and an Effect HttpClient directly; there is no client layer,
 * pagination, retry policy, endpoint override or resource-creation fallback.
 */
const request = Effect.fn("Notion.request")(function* <T>(
  method: "GET" | "POST" | "PATCH",
  resource: "users/me" | "databases" | "data_sources",
  schema: Schema.Codec<T, unknown>,
  id?: string,
  query = false,
  body?: Readonly<Record<string, unknown>>,
) {
  const credentials = yield* Credentials;
  const client = yield* HttpClient.HttpClient;
  const path = yield* Effect.try({
    try: () =>
      `${resource}${id === undefined ? "" : `/${encodeURIComponent(id)}`}${query ? "/query" : ""}`,
    catch: () => new NotionApiError({ message: "Invalid Notion resource identifier" }),
  });
  const httpRequest = HttpClientRequest.make(method)(`https://api.notion.com/v1/${path}`).pipe(
    HttpClientRequest.bearerToken(credentials.token),
    HttpClientRequest.setHeader("Notion-Version", "2025-09-03"),
    HttpClientRequest.setHeader("Accept", "application/json"),
  );
  const encoded = body === undefined
    ? httpRequest
    : yield* HttpClientRequest.bodyJson(body)(httpRequest).pipe(
        Effect.mapError(() => new NotionApiError({ message: "Invalid Notion request payload" })),
      );
  const response = yield* client.execute(encoded).pipe(
    Effect.mapError(() => new NotionApiError({ message: "Notion transport failed" })),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new NotionApiError({
      message: "Notion API rejected the request",
      status: response.status,
    });
  }
  const json = yield* response.json.pipe(
    Effect.mapError(() => new NotionApiError({ message: "Invalid Notion JSON response" })),
  );
  return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
    Effect.mapError(() => new NotionApiError({ message: "Invalid Notion response metadata" })),
  );
});

export const NotionUsers = {
  me: () => request("GET", "users/me", Identity),
};

export const NotionDatabases = {
  retrieve: ({ databaseId }: { readonly databaseId: string }) =>
    request("GET", "databases", Database, databaseId),
  query: ({ dataSourceId, pageSize, filter }: {
    readonly dataSourceId: string;
    readonly pageSize: number;
    readonly filter: Readonly<Record<string, unknown>>;
  }) => request("POST", "data_sources", Query, dataSourceId, true, {
    page_size: pageSize,
    filter,
  }),
};

export const NotionDataSources = {
  retrieve: ({ dataSourceId }: { readonly dataSourceId: string }) =>
    request("GET", "data_sources", DataSource, dataSourceId),
  update: ({ dataSourceId, properties }: {
    readonly dataSourceId: string;
    readonly properties: Readonly<Record<string, unknown>>;
  }) => request("PATCH", "data_sources", DataSource, dataSourceId, false, { properties }),
};
