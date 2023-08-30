import { JsonObject } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { AgentError } from '../../errors';
import { requestIdOf } from '../../request_id';
import { SignIdentity } from '../../auth';
import * as cbor from '../../cbor';
import { compare, concat, fromHex } from '../../utils/buffer';
import {
  Agent,
  ApiQueryResponse,
  QueryFields,
  QueryResponse,
  ReadStateOptions,
  ReadStateResponse,
  SubmitResponse,
} from '../api';
import { Expiry, httpHeadersTransform } from '../http/transforms';
import {
  CallRequest,
  Endpoint,
  Envelope,
  QueryRequest,
  ReadRequestType,
  ReadStateRequest,
  SubmitRequestType,
} from '../http/types';
import { makeWsNonceTransform } from './transforms';
import {
  WsAgentQueryRequest,
  WsAgentReadStateRequest,
  WsAgentRequest,
  WsAgentRequestMessage,
  WsAgentRequestTransformFn,
  WsAgentSubmitRequest,
  isWsAgentResponse,
} from './types';
import { AgentWsResponseError } from './errors';
import { HttpAgent, IdentityInvalidError, makeNonce } from '../http';

const domainSeparator = new TextEncoder().encode('\x0Aic-request');

// Default delta for ingress expiry is 5 minutes.
const DEFAULT_INGRESS_EXPIRY_DELTA_IN_MSECS = 5 * 60 * 1000;

// Root public key for the IC, encoded as hex
const IC_ROOT_KEY =
  '308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100814' +
  'c0e6ec71fab583b08bd81373c255c3c371b2e84863c98a4f1e08b74235d14fb5d9c0cd546d968' +
  '5f913a0c0b2cc5341583bf4b4392e467db96d65b9bb4cb717112f8472e0d5a4d14505ffd7484' +
  'b01291091c5f87b98883463f98091a0baaae';

class DefaultWsError extends AgentError {
  constructor(public readonly message: string) {
    super(message);
  }
}

export interface WsAgentOptions {
  // Another HttpAgent to inherit configuration (pipeline and fetch) of. This
  // is only used at construction.
  source?: WsAgent;

  // Must be an **open** WebSocket instance.
  ws: WebSocket;

  // The http agent needed to fetch the root key.
  httpAgent: HttpAgent;

  // The principal used to send messages. This cannot be empty at the request
  // time (will throw).
  identity: SignIdentity | Promise<SignIdentity>;

  /**
   * Prevents the agent from providing a unique {@link Nonce} with each call.
   * Enabling may cause rate limiting of identical requests
   * at the boundary nodes.
   *
   * To add your own nonce generation logic, you can use the following:
   * @example
   * import {makeNonceTransform, makeNonce} from '@dfinity/agent';
   * const agent = new HttpAgent({ disableNonce: true });
   * agent.addTransform(makeNonceTransform(makeNonce);
   * @default false
   */
  disableNonce?: boolean;
  /**
   * Number of times to retry requests before throwing an error
   * @default 3
   */
  retryTimes?: number;
}

export class WsAgent implements Agent {
  public rootKey = fromHex(IC_ROOT_KEY);
  private readonly _pipeline: WsAgentRequestTransformFn[] = [];
  private _identity: Promise<SignIdentity>;
  private readonly _ws: WebSocket;
  private _timeDiffMsecs = 0;
  private _httpAgent: HttpAgent;
  private _rootKeyFetched = false;
  private readonly _retryTimes; // Retry requests N times before erroring by default
  public readonly _isAgent = true;

  constructor(options: WsAgentOptions) {
    if (options.source) {
      if (!(options.source instanceof WsAgent)) {
        throw new Error("An Agent's source can only be another WsAgent");
      }
      this._pipeline = [...options.source._pipeline];
      this._identity = options.source._identity;
      this._ws = options.source._ws;
      this._httpAgent = options.source._httpAgent;
    } else {
      if (!options.identity) {
        throw new Error('An identity must be provided to the WsAgent');
      }
      this._identity = Promise.resolve(options.identity);
      if (!options.ws) {
        throw new Error('A WebSocket instance must be provided to the WsAgent');
      } else if (options.ws.readyState !== WebSocket.OPEN) {
        throw new DefaultWsError('The provided WebSocket is not open');
      }
      this._ws = options.ws;
      if (!options.httpAgent) {
        throw new Error('An httpAgent must be provided to the WsAgent');
      }
      this._httpAgent = options.httpAgent;
    }
    // Default is 3, only set from option if greater or equal to 0
    this._retryTimes =
      options.retryTimes !== undefined && options.retryTimes >= 0 ? options.retryTimes : 3;

    // Add a nonce transform to ensure calls are unique
    if (!options.disableNonce) {
      this.addTransform(makeWsNonceTransform(makeNonce));
    }
  }

  public addTransform(fn: WsAgentRequestTransformFn, priority = fn.priority || 0): void {
    // Keep the pipeline sorted at all time, by priority.
    const i = this._pipeline.findIndex(x => (x.priority || 0) < priority);
    this._pipeline.splice(i >= 0 ? i : this._pipeline.length, 0, Object.assign(fn, { priority }));
  }

  public async getPrincipal(): Promise<Principal> {
    if (!this._identity) {
      throw new IdentityInvalidError(
        "This identity has expired due this application's security policy. Please refresh your authentication.",
      );
    }
    return (await this._identity).getPrincipal();
  }

  public async call(
    canisterId: Principal | string,
    options: {
      methodName: string;
      arg: ArrayBuffer;
      effectiveCanisterId?: Principal | string;
    },
  ): Promise<SubmitResponse> {
    const id = await this._identity;
    if (!id) {
      throw new IdentityInvalidError(
        "This identity has expired due this application's security policy. Please refresh your authentication.",
      );
    }
    const canister = Principal.from(canisterId);

    const sender: Principal = id.getPrincipal();

    let ingress_expiry = new Expiry(DEFAULT_INGRESS_EXPIRY_DELTA_IN_MSECS);

    // If the value is off by more than 30 seconds, reconcile system time with the network
    if (Math.abs(this._timeDiffMsecs) > 1_000 * 30) {
      ingress_expiry = new Expiry(DEFAULT_INGRESS_EXPIRY_DELTA_IN_MSECS + this._timeDiffMsecs);
    }

    const submit: CallRequest = {
      request_type: SubmitRequestType.Call,
      canister_id: canister,
      method_name: options.methodName,
      arg: options.arg,
      sender,
      ingress_expiry,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformedRequest = (await this._transform({
      endpoint: Endpoint.Call,
      message: submit,
    })) as WsAgentSubmitRequest;

    const envelope = await this._signRequest(transformedRequest.message, id);
    const message: WsAgentRequestMessage<CallRequest> = {
      envelope,
      canister_id: canister,
      nonce: makeNonce(),
    };

    const request = this._requestAndRetry(message);

    const requestId = requestIdOf(submit);
    const response = await request;

    const responseBuffer = await response.arrayBuffer();
    const responseBody = (
      response.status === 200 && responseBuffer.byteLength > 0 ? cbor.decode(responseBuffer) : null
    ) as SubmitResponse['response']['body'];

    return {
      requestId,
      response: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        headers: httpHeadersTransform(response.headers),
      },
    };
  }

  private async _signRequest<T extends Record<string, any>>(
    message: T,
    identity: SignIdentity,
  ): Promise<Envelope<T>> {
    const requestId = requestIdOf(message);
    return {
      content: message,
      sender_pubkey: identity.getPublicKey().toDer(),
      sender_sig: await identity.sign(concat(domainSeparator, requestId)),
    };
  }

  /**
   * Sends the request body to the WebSocket Gateway
   * and subscribes to the incoming messages to wait for the response.
   */
  private async _requestAndRetry<T>(
    message: WsAgentRequestMessage<T>,
    tries = 0,
  ): Promise<Response> {
    const messageNonce = message.nonce;
    const messageBytes = cbor.encode(message);

    const request = new Promise<Response>((resolve, _) => {
      const handler = (event: MessageEvent) => {
        const res = cbor.decode(event.data as ArrayBuffer);
        if (isWsAgentResponse(res)) {
          if (compare(res.nonce, messageNonce) === 0) {
            this._ws.removeEventListener('message', handler);
            const response = new Response(res.payload.content, {
              status: res.payload.status,
              headers: res.payload.contentType
                ? {
                    'Content-Type': res.payload.contentType,
                  }
                : undefined,
            });
            resolve(response);
          }
        }
      };
      this._ws.addEventListener('message', handler);
      this._ws.send(messageBytes);
    });

    const response = await request;
    if (response.ok) {
      return response;
    }

    const responseText = await response.clone().text();
    const errorMessage =
      `Server returned an error:\n` +
      `  Code: ${response.status} (${response.statusText})\n` +
      `  Body: ${responseText}\n`;

    if (this._retryTimes > tries) {
      console.warn(errorMessage + `  Retrying request.`);
      return await this._requestAndRetry(message, tries + 1);
    }

    throw new AgentWsResponseError(errorMessage, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: httpHeadersTransform(response.headers),
    });
  }

  public async query(
    canisterId: Principal | string,
    fields: QueryFields,
  ): Promise<ApiQueryResponse> {
    const id = await this._identity;
    if (!id) {
      throw new IdentityInvalidError(
        "This identity has expired due this application's security policy. Please refresh your authentication.",
      );
    }

    const canister = typeof canisterId === 'string' ? Principal.fromText(canisterId) : canisterId;
    const sender = id.getPrincipal();

    const queryRequest: QueryRequest = {
      request_type: ReadRequestType.Query,
      canister_id: canister,
      method_name: fields.methodName,
      arg: fields.arg,
      sender,
      ingress_expiry: new Expiry(DEFAULT_INGRESS_EXPIRY_DELTA_IN_MSECS),
    };

    const transformedRequest = (await this._transform({
      endpoint: Endpoint.Query,
      message: queryRequest,
    })) as WsAgentQueryRequest;

    const envelope = await this._signRequest(transformedRequest.message, id);
    const message: WsAgentRequestMessage<QueryRequest> = {
      envelope,
      canister_id: canister,
      nonce: makeNonce(),
    };

    const request = this._requestAndRetry(message);

    const response = await request;

    const queryResponse: QueryResponse = cbor.decode(await response.arrayBuffer());

    return {
      ...queryResponse,
      httpDetails: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: httpHeadersTransform(response.headers),
      },
    };
  }

  public async createReadStateRequest(
    fields: ReadStateOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Envelope<ReadStateRequest>> {
    const id = await this._identity;
    if (!id) {
      throw new IdentityInvalidError(
        "This identity has expired due this application's security policy. Please refresh your authentication.",
      );
    }
    const sender = id.getPrincipal();

    // TODO: remove this any. This can be a Signed or UnSigned request.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformedRequest = (await this._transform({
      endpoint: Endpoint.ReadState,
      message: {
        request_type: ReadRequestType.ReadState,
        paths: fields.paths,
        sender,
        ingress_expiry: new Expiry(DEFAULT_INGRESS_EXPIRY_DELTA_IN_MSECS),
      },
    })) as WsAgentReadStateRequest;

    return this._signRequest(transformedRequest.message, id);
  }

  public async readState(
    canisterId: Principal | string,
    fields: ReadStateOptions,
  ): Promise<ReadStateResponse> {
    const canister = typeof canisterId === 'string' ? Principal.fromText(canisterId) : canisterId;

    const envelope = await this.createReadStateRequest(fields);
    const message: WsAgentRequestMessage<ReadStateRequest> = {
      envelope,
      canister_id: canister,
      nonce: makeNonce(),
    };

    const request = this._requestAndRetry(message);

    const response = await request;

    if (!response.ok) {
      throw new Error(
        `Server returned an error:\n` +
          `  Code: ${response.status} (${response.statusText})\n` +
          `  Body: ${await response.text()}\n`,
      );
    }
    return cbor.decode(await response.arrayBuffer());
  }

  /**
   * Allows agent to sync its time with the network. Can be called during intialization or mid-lifecycle if the device's clock has drifted away from the network time. This is necessary to set the Expiry for a request
   * @param {Principal} canisterId - Pass a canister ID if you need to sync the time with a particular replica. Uses the management canister by default
   */
  public async syncTime(canisterId?: Principal): Promise<void> {
    const CanisterStatus = await import('../../canisterStatus');
    const callTime = Date.now();
    try {
      if (!canisterId) {
        console.log(
          'Syncing time with the IC. No canisterId provided, so falling back to ryjl3-tyaaa-aaaaa-aaaba-cai',
        );
      }
      const status = await CanisterStatus.request({
        // Fall back with canisterId of the ICP Ledger
        canisterId: canisterId ?? Principal.from('ryjl3-tyaaa-aaaaa-aaaba-cai'),
        agent: this._httpAgent,
        paths: ['time'],
      });

      const replicaTime = status.get('time');
      if (replicaTime) {
        this._timeDiffMsecs = Number(replicaTime as any) - Number(callTime);
      }
    } catch (error) {
      console.error('Caught exception while attempting to sync time:', error);
    }
  }

  public async status(): Promise<JsonObject> {
    return this._httpAgent.status();
  }

  public async fetchRootKey(): Promise<ArrayBuffer> {
    if (!this._rootKeyFetched) {
      // Hex-encoded version of the replica root key
      this.rootKey = ((await this.status()) as any).root_key;
      this._rootKeyFetched = true;
    }
    return this.rootKey;
  }

  public replaceIdentity(identity: SignIdentity): void {
    this._identity = Promise.resolve(identity);
  }

  protected _transform(request: WsAgentRequest): Promise<WsAgentRequest> {
    let p = Promise.resolve(request);

    for (const fn of this._pipeline) {
      p = p.then(r => fn(r).then(r2 => r2 || r));
    }

    return p;
  }
}
