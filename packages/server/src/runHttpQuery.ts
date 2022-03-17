import { Request, Headers } from 'node-fetch';
import type { default as GraphQLOptions } from './graphqlOptions';
import { ApolloError, formatApolloErrors } from './errors';
import {
  processGraphQLRequest,
  GraphQLRequest,
  GraphQLRequestContext,
  GraphQLResponse,
} from './requestPipeline';
import type {
  WithRequired,
  GraphQLExecutionResult,
  BaseContext,
} from '@apollo/server-types';
import { newCachePolicy } from './cachePolicy';

export interface HttpQueryRequest<TContext extends BaseContext> {
  method: string;
  // query is either the POST body or the GET query string map.  In the GET
  // case, all values are strings and need to be parsed as JSON; in the POST
  // case they should already be parsed. query has keys like 'query' (whose
  // value should always be a string), 'variables', 'operationName',
  // 'extensions', etc.
  query: Record<string, any> | Array<Record<string, any>>;
  options: GraphQLOptions<TContext>;
  context: TContext;
  request: Pick<Request, 'url' | 'method' | 'headers'>;
}

interface ApolloServerHttpResponse {
  headers?: Record<string, string>;
  status?: number;
  // ResponseInit contains the follow, which we do not use
  // statusText?: string;
}

interface HttpQueryResponse {
  // TODO: This isn't actually an individual GraphQL response, but the body
  // of the HTTP response, which could contain multiple GraphQL responses
  // when using batching.
  graphqlResponse: string;
  responseInit: ApolloServerHttpResponse;
}

export class HttpQueryError extends Error {
  public statusCode: number;
  public isGraphQLError: boolean;
  public headers?: { [key: string]: string };

  constructor(
    statusCode: number,
    message: string,
    isGraphQLError: boolean = false,
    headers?: { [key: string]: string },
  ) {
    super(message);
    this.name = 'HttpQueryError';
    this.statusCode = statusCode;
    this.isGraphQLError = isGraphQLError;
    this.headers = headers;
  }
}

export function isHttpQueryError(e: unknown): e is HttpQueryError {
  return (e as any)?.name === 'HttpQueryError';
}

/**
 * If options is specified, then the errors array will be formatted
 */
export function throwHttpGraphQLError<
  TContext extends BaseContext,
  E extends Error,
>(
  statusCode: number,
  errors: Array<E>,
  options?: Pick<GraphQLOptions<TContext>, 'debug' | 'formatError'>,
  extensions?: GraphQLExecutionResult['extensions'],
  headers?: Headers,
): never {
  const allHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (headers) {
    for (const [name, value] of headers) {
      allHeaders[name] = value;
    }
  }

  type Result = Pick<GraphQLExecutionResult, 'extensions'> & {
    errors: E[] | ApolloError[];
  };

  const result: Result = {
    errors: options
      ? formatApolloErrors(errors, {
          debug: options.debug,
          formatter: options.formatError,
        })
      : errors,
  };

  if (extensions) {
    result.extensions = extensions;
  }

  throw new HttpQueryError(
    statusCode,
    prettyJSONStringify(result),
    true,
    allHeaders,
  );
}

const NODE_ENV = process.env.NODE_ENV ?? '';

// TODO(AS4): this probably can be un-exported once we clean up context function
// error handling
export function debugFromNodeEnv(nodeEnv: string = NODE_ENV) {
  return nodeEnv !== 'production' && nodeEnv !== 'test';
}

export async function runHttpQuery<TContext extends BaseContext>(
  request: HttpQueryRequest<TContext>,
): Promise<HttpQueryResponse> {
  const { options } = request;

  if (options.debug === undefined) {
    options.debug = debugFromNodeEnv(options.nodeEnv);
  }

  const config = {
    schema: options.schema,
    logger: options.logger,
    rootValue: options.rootValue,
    context: request.context,
    validationRules: options.validationRules,
    executor: options.executor,
    fieldResolver: options.fieldResolver,

    // TODO: Use proper option types to ensure this
    // The cache is guaranteed to be initialized in ApolloServer, and
    // cacheControl defaults will also have been set if a boolean argument is
    // passed in.
    cache: options.cache!,
    documentStore: options.documentStore,

    persistedQueries: options.persistedQueries,

    formatError: options.formatError,
    formatResponse: options.formatResponse,

    debug: options.debug,

    plugins: options.plugins || [],

    allowBatchedHttpRequests: options.allowBatchedHttpRequests,
  };

  return processHTTPRequest(config, request);
}

export async function processHTTPRequest<TContext>(
  options: WithRequired<GraphQLOptions<TContext>, 'cache' | 'plugins'> & {
    context: TContext;
  },
  httpRequest: HttpQueryRequest<TContext>,
): Promise<HttpQueryResponse> {
  let requestPayload;

  switch (httpRequest.method) {
    case 'POST':
      if (
        !httpRequest.query ||
        typeof httpRequest.query === 'string' ||
        Buffer.isBuffer(httpRequest.query) ||
        Object.keys(httpRequest.query).length === 0
      ) {
        throw new HttpQueryError(
          400,
          'POST body missing, invalid Content-Type, or JSON object has no keys.',
        );
      }

      requestPayload = httpRequest.query;
      break;
    case 'GET':
      if (!httpRequest.query || Object.keys(httpRequest.query).length === 0) {
        throw new HttpQueryError(400, 'GET query missing.');
      }

      requestPayload = httpRequest.query;
      break;

    default:
      throw new HttpQueryError(
        405,
        'Apollo Server supports only GET/POST requests.',
        false,
        {
          Allow: 'GET, POST',
        },
      );
  }

  const plugins = [...options.plugins];

  // GET operations should only be queries (not mutations). We want to throw
  // a particular HTTP error in that case.
  if (httpRequest.method === 'GET') {
    plugins.unshift({
      async requestDidStart() {
        return {
          async didResolveOperation({ operation }) {
            if (operation.operation !== 'query') {
              throw new HttpQueryError(
                405,
                `GET supports only query operation`,
                false,
                {
                  Allow: 'POST',
                },
              );
            }
          },
        };
      },
    });
  }

  // Create a local copy of `options`, based on global options, but maintaining
  // that appropriate plugins are in place.
  options = {
    ...options,
    plugins,
  };

  function buildRequestContext(
    request: GraphQLRequest,
  ): GraphQLRequestContext<TContext> {
    // TODO: We currently shallow clone the context for every request,
    // but that's unlikely to be what people want.
    // We allow passing in a function for `context` to ApolloServer,
    // but this only runs once for a batched request (because this is resolved
    // in ApolloServer#graphQLServerOptions, before runHttpQuery is invoked).
    // (Actually, this likely *IS* what people want: perhaps the biggest benefit
    // of the batched HTTP protocol is sharing context (eg DataLoaders across
    // operations.)
    // NOTE: THIS IS DUPLICATED IN ApolloServerBase.prototype.executeOperation.
    const context = cloneObject(options.context);
    return {
      // While `logger` is guaranteed by internal Apollo Server usage of
      // this `processHTTPRequest` method, this method has been publicly
      // exported since perhaps as far back as Apollo Server 1.x.  Therefore,
      // for compatibility reasons, we'll default to `console`.
      logger: options.logger || console,
      schema: options.schema,
      request,
      response: {
        http: {
          headers: new Headers(),
        },
      },
      context,
      cache: options.cache,
      debug: options.debug,
      metrics: {},
      overallCachePolicy: newCachePolicy(),
    };
  }

  const responseInit: ApolloServerHttpResponse = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  let body: string;

  try {
    if (Array.isArray(requestPayload)) {
      if (options.allowBatchedHttpRequests === false) {
        return throwHttpGraphQLError(
          400,
          [new Error('Operation batching disabled.')],
          options,
        );
      }

      // We're processing a batch request
      const requests = requestPayload.map((requestParams) =>
        parseGraphQLRequest(httpRequest.request, requestParams),
      );

      const responses = await Promise.all(
        requests.map(async (request) => {
          try {
            const requestContext = buildRequestContext(request);
            const response = await processGraphQLRequest(
              options,
              requestContext,
            );
            if (response.http) {
              for (const [name, value] of response.http.headers) {
                responseInit.headers![name] = value;
              }

              if (response.http.status) {
                responseInit.status = response.http.status;
              }
            }
            return response;
          } catch (error) {
            // A batch can contain another query that returns data,
            // so we don't error out the entire request with an HttpError
            return {
              errors: formatApolloErrors([error as Error], options),
            };
          }
        }),
      );

      body = prettyJSONStringify(responses.map(serializeGraphQLResponse));
    } else {
      // We're processing a normal request
      const request = parseGraphQLRequest(httpRequest.request, requestPayload);

      const requestContext = buildRequestContext(request);

      const response = await processGraphQLRequest(options, requestContext);

      // This code is run on parse/validation errors and any other error that
      // doesn't reach GraphQL execution
      if (response.errors && typeof response.data === 'undefined') {
        // don't include options, since the errors have already been formatted
        return throwHttpGraphQLError(
          response.http?.status || 400,
          response.errors as any,
          undefined,
          response.extensions,
          response.http?.headers,
        );
      }

      if (response.http) {
        for (const [name, value] of response.http.headers) {
          responseInit.headers![name] = value;
        }

        if (response.http.status) {
          responseInit.status = response.http.status;
        }
      }

      body = prettyJSONStringify(serializeGraphQLResponse(response));
    }
  } catch (error) {
    if (error instanceof HttpQueryError) {
      throw error;
    }
    return throwHttpGraphQLError(500, [error as Error], options);
  }

  responseInit.headers!['Content-Length'] = Buffer.byteLength(
    body,
    'utf8',
  ).toString();

  return {
    graphqlResponse: body,
    responseInit,
  };
}

function parseGraphQLRequest(
  httpRequest: Pick<Request, 'url' | 'method' | 'headers'>,
  requestParams: Record<string, any>,
): GraphQLRequest {
  let queryString: string | undefined = requestParams.query;
  let extensions = requestParams.extensions;

  if (typeof extensions === 'string' && extensions !== '') {
    // For GET requests, we have to JSON-parse extensions. (For POST
    // requests they get parsed as part of parsing the larger body they're
    // inside.)
    try {
      extensions = JSON.parse(extensions);
    } catch (error) {
      throw new HttpQueryError(400, 'Extensions are invalid JSON.');
    }
  }

  if (queryString && typeof queryString !== 'string') {
    // Check for a common error first.
    if ((queryString as any).kind === 'Document') {
      throw new HttpQueryError(
        400,
        "GraphQL queries must be strings. It looks like you're sending the " +
          'internal graphql-js representation of a parsed query in your ' +
          'request instead of a request in the GraphQL query language. You ' +
          'can convert an AST to a string using the `print` function from ' +
          '`graphql`, or use a client like `apollo-client` which converts ' +
          'the internal representation to a string for you.',
      );
    } else {
      throw new HttpQueryError(400, 'GraphQL queries must be strings.');
    }
  }

  const operationName = requestParams.operationName;

  let variables = requestParams.variables;
  if (typeof variables === 'string' && variables !== '') {
    try {
      // XXX Really we should only do this for GET requests, but for
      // compatibility reasons we'll keep doing this at least for now for
      // broken clients that ship variables in a string for no good reason.
      variables = JSON.parse(variables);
    } catch (error) {
      throw new HttpQueryError(400, 'Variables are invalid JSON.');
    }
  }

  return {
    query: queryString,
    operationName,
    variables,
    extensions,
    http: httpRequest,
  };
}

function serializeGraphQLResponse(
  response: GraphQLResponse,
): Pick<GraphQLResponse, 'errors' | 'data' | 'extensions'> {
  // See https://github.com/facebook/graphql/pull/384 for why
  // errors comes first.
  return {
    errors: response.errors,
    data: response.data,
    extensions: response.extensions,
  };
}

// The result of a curl does not appear well in the terminal, so we add an extra new line
function prettyJSONStringify(value: any) {
  return JSON.stringify(value) + '\n';
}

export function cloneObject<T extends Object>(object: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(object)), object);
}