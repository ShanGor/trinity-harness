import type {
  LLMRequest,
  ModelPricing,
  ModelUsage,
  SessionEvent,
  SessionStore,
  TaskBudget,
  TaskBudgetScope,
  TaskExecutionPort,
} from '@trinity-harness/contracts';
import { taskBudgetSchema } from '@trinity-harness/contracts';
import { moneyAmount, moneyUnits, newId } from '@trinity-harness/shared';
import { estimateRequestTokens } from '../context/estimate-tokens.js';

export class TaskBudgetError extends Error {
  readonly code = 'TASK_BUDGET_EXHAUSTED';
}

/** Admission is decided by the ordered log prefix, including concurrent child reservations. */
export class EventTaskExecution implements TaskExecutionPort {
  constructor(
    private readonly store: SessionStore,
    private readonly limits: TaskBudget = taskBudgetSchema.parse({}),
    private readonly prices: ModelPricing = {},
    private readonly now: () => number = Date.now,
  ) {}

  async open(
    sessionId: string,
    promptId: string,
    signal?: AbortSignal,
    actor?: string,
  ): Promise<TaskBudgetScope> {
    const appendOpts = actor ? { actor } : undefined;
    let events = await this.store.load(sessionId);
    if (!events.some((event) => event.type === 'task/budget' && event.promptId === promptId)) {
      await this.store.append(
        sessionId,
        [
          {
            eventId: newId(),
            at: new Date(this.now()).toISOString(),
            type: 'task/budget',
            promptId,
            limits: taskBudgetSchema.parse(this.limits),
          },
        ],
        appendOpts,
      );
      events = await this.store.load(sessionId);
    }
    const start = events.find(
      (event) => event.type === 'task/budget' && event.promptId === promptId,
    )!;
    if (start.type !== 'task/budget') throw new Error('Missing task budget');
    const limits = start.limits;
    const remainingMs = Date.parse(start.at) + limits.maxDurationMs - this.now();
    const lifetime = new AbortController();
    const deadline = AbortSignal.timeout(Math.max(0, remainingMs));
    const combined = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    const read = async (): Promise<SessionEvent[]> => this.store.load(sessionId);
    const size = (request: LLMRequest): number =>
      Math.ceil(estimateRequestTokens(request) * 1.15) + (request.maxOutputTokens ?? 8192);
    const costs = (request: LLMRequest): { currency: string; amount: string }[] =>
      limits.maxCost.map((ceiling) => {
        const prices = this.prices[request.model]?.filter(
          (price) => price.currency === ceiling.currency,
        );
        if (!prices?.length)
          throw new TaskBudgetError(
            `Task cost cannot be bounded: missing ${ceiling.currency} price for ${request.model}`,
          );
        const maximum = (rates: (string | undefined)[]): bigint =>
          rates.reduce<bigint>(
            (max, rate) => (rate !== undefined && moneyUnits(rate) > max ? moneyUnits(rate) : max),
            0n,
          );
        const input = maximum(
          prices.flatMap((price) => [
            price.input,
            price.cacheRead,
            price.cacheWrite,
            price.cacheWrite1h,
          ]),
        );
        const output = maximum(prices.map((price) => price.output));
        return {
          currency: ceiling.currency,
          amount: moneyAmount(
            (BigInt(Math.ceil(estimateRequestTokens(request) * 1.15)) * input +
              BigInt(request.maxOutputTokens ?? 8192) * output) /
              1_000_000n,
          ),
        };
      });
    const usage = (
      history: readonly SessionEvent[],
      through?: string,
    ): { requests: number; tokens: number; costs: Map<string, bigint> } => {
      const settled = new Map(
        history.flatMap((event) =>
          event.type === 'model/usage' && event.usage.promptId === promptId
            ? [[event.usage.requestId, event.usage] as const]
            : [],
        ),
      );
      let requests = 0;
      let tokens = 0;
      const denied = new Set(
        history.flatMap((event) => (event.type === 'task/request_denied' ? [event.requestId] : [])),
      );
      const totals = new Map<string, bigint>();
      for (const event of history) {
        if (
          event.type !== 'task/request' ||
          event.promptId !== promptId ||
          denied.has(event.requestId)
        )
          continue;
        requests++;
        const actual = settled.get(event.requestId);
        const known =
          actual?.tokens.inputTokens !== undefined && actual.tokens.outputTokens !== undefined;
        tokens += known
          ? actual.tokens.inputTokens! + actual.tokens.outputTokens!
          : event.reservedTokens;
        const bill = actual?.cost ? [actual.cost] : event.reservedCost;
        for (const cost of bill)
          totals.set(cost.currency, (totals.get(cost.currency) ?? 0n) + moneyUnits(cost.amount));
        if (event.requestId === through) break;
      }
      return { requests, tokens, costs: totals };
    };
    return {
      signal: combined,
      maxSteps: limits.maxSteps,
      shouldFinalize: async (request) => {
        const used = usage(await read());
        return (
          used.requests + 1 >= limits.maxRequests ||
          used.tokens + size(request) * 2 > limits.maxTokens ||
          costs(request).some(
            (cost) =>
              (used.costs.get(cost.currency) ?? 0n) + moneyUnits(cost.amount) * 2n >
              moneyUnits(limits.maxCost.find((limit) => limit.currency === cost.currency)!.amount),
          )
        );
      },
      shouldConclude: async (request) => {
        const used = usage(await read());
        return (
          used.requests + 1 > Math.max(0, limits.maxRequests - limits.reserveRequests) ||
          used.tokens + size(request) >
            Math.max(0, limits.maxTokens - Math.max(limits.reserveTokens, size(request))) ||
          costs(request).some(
            (cost) =>
              (used.costs.get(cost.currency) ?? 0n) + moneyUnits(cost.amount) >
              moneyUnits(limits.maxCost.find((limit) => limit.currency === cost.currency)!.amount),
          )
        );
      },
      admit: async (request, purpose, lane) => {
        if (combined.aborted || this.now() >= Date.parse(start.at) + limits.maxDurationMs)
          throw new TaskBudgetError('Task deadline reached');
        const requestId = newId();
        const reservedCost = costs(request);
        await this.store.append(
          sessionId,
          [
            {
              eventId: newId(),
              at: new Date(this.now()).toISOString(),
              type: 'task/request',
              promptId,
              requestId,
              model: request.model,
              purpose,
              estimatedInputTokens: estimateRequestTokens({
                ...request,
                estimatedInputTokens: undefined,
              }),
              reservedTokens: size(request),
              reservedCost,
              lane,
            },
          ],
          appendOpts,
        );
        const used = usage(await read(), requestId);
        const reserved = lane === 'work' || purpose === 'subagent';
        const requestReserve = reserved
          ? Math.min(limits.reserveRequests, limits.maxRequests)
          : lane === 'verification'
            ? 1
            : 0;
        const tokenReserve = reserved
          ? Math.min(limits.reserveTokens, limits.maxTokens)
          : lane === 'verification'
            ? size(request)
            : 0;
        if (
          used.requests > limits.maxRequests - requestReserve ||
          used.tokens > limits.maxTokens - tokenReserve ||
          limits.maxCost.some(
            (cost) => (used.costs.get(cost.currency) ?? 0n) > moneyUnits(cost.amount),
          )
        ) {
          await this.store.append(
            sessionId,
            [
              {
                eventId: newId(),
                at: new Date(this.now()).toISOString(),
                type: 'task/request_denied',
                promptId,
                requestId,
              },
            ],
            appendOpts,
          );
          throw new TaskBudgetError(
            'Task request/token/cost budget exhausted; unfinished work remains',
          );
        }
        return requestId;
      },
      record: async (entry: ModelUsage) => {
        // Child usage is persisted to the owning task before returning to the parent.
        if (
          (await read()).some(
            (event) => event.type === 'model/usage' && event.usage.requestId === entry.requestId,
          )
        )
          return;
        await this.store.append(
          sessionId,
          [
            {
              eventId: newId(),
              at: new Date(this.now()).toISOString(),
              type: 'model/usage',
              usage: { ...entry, promptId },
            },
          ],
          appendOpts,
        );
      },
      dispose: () => lifetime.abort(),
    };
  }
}
