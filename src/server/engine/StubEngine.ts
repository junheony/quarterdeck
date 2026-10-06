import { ZERO_USAGE } from '../../shared/turn-types';
import type { Engine, EngineEvent, EngineResult, TurnRequest } from './Engine';

/** An async iterable lets a test hold the stream open after its result (the CLI process still closing). */
export type StubHandler = (req: TurnRequest, call: number) => Promise<EngineEvent[] | AsyncIterable<EngineEvent>> | EngineEvent[] | AsyncIterable<EngineEvent>;

export function okResult(sessionId: string, text = 'ok'): EngineResult {
  return { kind: 'result', sessionId, ok: true, text, usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 100 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' };
}

export function failResult(errorText: string, extra: Partial<EngineResult> = {}): EngineResult {
  return { kind: 'result', sessionId: null, ok: false, text: '', usage: ZERO_USAGE, errorText, stderr: null, errorKind: null, terminalReason: null, ...extra };
}

export class StubEngine implements Engine {
  calls: TurnRequest[] = [];

  constructor(private readonly handler: StubHandler) {}

  async *runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    const call = this.calls.length;
    this.calls.push(req);
    const r = await this.handler(req, call);
    if (Symbol.asyncIterator in r) yield* r;
    else for (const e of r) yield e;
  }
}
