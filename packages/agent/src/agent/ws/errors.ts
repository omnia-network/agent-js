import { HttpDetailsResponse } from '../api';

export class AgentWsResponseError extends Error {
  constructor(message: string, public readonly response: HttpDetailsResponse) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
