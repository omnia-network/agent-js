import type { Principal } from '@dfinity/principal';
import { CallRequest, Endpoint, Envelope, QueryRequest, ReadStateRequest } from '../http/types';

export type WsAgentRequest = WsAgentQueryRequest | WsAgentSubmitRequest | WsAgentReadStateRequest;

export interface WsAgentBaseRequest {
  readonly endpoint: Endpoint;
}

export interface WsAgentSubmitRequest extends WsAgentBaseRequest {
  readonly endpoint: Endpoint.Call;
  message: CallRequest;
}

export interface WsAgentQueryRequest extends WsAgentBaseRequest {
  readonly endpoint: Endpoint.Query;
  message: QueryRequest;
}

export interface WsAgentReadStateRequest extends WsAgentBaseRequest {
  readonly endpoint: Endpoint.ReadState;
  message: ReadStateRequest;
}

export interface WsAgentRequestTransformFn {
  (args: WsAgentRequest): Promise<WsAgentRequest | undefined | void>;
  priority?: number;
}

export type WsAgentRequestMessage<T> = {
  envelope: Envelope<T>;
  canister_id: Principal;
  nonce: Uint8Array;
};

export type WsAgentResponse = {
  payload: {
    status: number;
    contentType?: string;
    content: Uint8Array;
  };
  nonce: Uint8Array;
};

export function isWsAgentResponse(obj: unknown): obj is WsAgentResponse {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  if (!('payload' in obj && typeof (obj as WsAgentResponse)['payload'] === 'object')) {
    return false;
  }

  if (!('nonce' in obj && (obj as WsAgentResponse)['nonce'] instanceof Uint8Array)) {
    return false;
  }

  const payload = (obj as WsAgentResponse)['payload'];

  return (
    'status' in obj &&
    typeof payload['status'] === 'number' &&
    'content' in obj &&
    payload['content'] instanceof Uint8Array
  );
}
