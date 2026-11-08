import type { BrowserArguments, ToolAssessment, ToolContext } from '@trinity-harness/contracts';
import type { BrowserToolOptions } from './browser.js';
import { browserDeliveries, browserPromptIndex } from './browser-artifacts.js';

const consequential =
  /\b(pay|purchase|buy|checkout|place order|subscribe|transfer|delete|remove|erase|overwrite|send|publish|post|upload|share|invite|revoke|grant|password|security|permission|confirm order)\b|付款|支付|购买|下单|订阅|转账|删除|移除|覆盖|发送|发布|上传|分享|邀请|授权|撤销|密码|权限/i;
const search = /\b(search|query|find)\b|搜索|搜尋|查找/i;

/** Labels are untrusted evidence, not authority. Unknown effects require inspection, never a pixel approval. */
export async function assessBrowserAction(
  options: BrowserToolOptions,
  args: BrowserArguments,
  ctx: ToolContext,
): Promise<ToolAssessment> {
  if (!['click', 'fill', 'scroll', 'key'].includes(args.operation))
    return { decision: 'allowed', summary: '' };
  if (args.operation === 'scroll')
    return { decision: 'allowed', summary: `Scroll the current page ${args.direction}.` };
  const unavailable: ToolAssessment = {
    decision: 'unavailable',
    summary:
      'The action target or consequence is not established. Nothing was executed. Read a fresh page snapshot and use a named ref; do not ask the user to approve coordinates or retry an unexplained control.',
  };
  if (!('ref' in args) || !args.ref) return unavailable;
  const events = await options.store.load(ctx.sessionId);
  ctx.signal?.throwIfAborted();
  const deliveries = browserDeliveries(events, ctx.sessionId, browserPromptIndex(events));
  const delivery = deliveries.at(-1);
  const source = delivery?.result;
  if (
    delivery &&
    events
      .slice(delivery.seq)
      .some(
        (event) => event.type === 'browser/user_input' || event.type === 'browser/control_changed',
      )
  )
    return unavailable;
  if (!source?.snapshot || source.snapshot.snapshotId !== args.snapshotId) return unavailable;
  const target = source.snapshot.targets.find((target) => target.ref === args.ref);
  if (!target || target.disabled || target.sensitive || !target.name) return unavailable;
  const label = target.name;
  const site = new URL(source.url).origin;
  const summary = `On ${site}, activate “${label}”.`;
  if (
    args.operation === 'key' &&
    ['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(args.key)
  )
    return { decision: 'allowed', summary };
  if (args.operation === 'fill')
    return target.role === 'textbox' && target.actionKind === 'search' && search.test(label)
      ? { decision: 'allowed', summary: `Enter a search query in “${label}” on ${site}.` }
      : unavailable;
  if (consequential.test(label)) {
    // A bare final button does not identify what the user would be authorizing.
    if (
      /^(pay|buy|checkout|subscribe|delete|remove|send|publish|post|upload|share|confirm|付款|支付|购买|删除|发送|发布|上传|分享)$/i.test(
        label.trim(),
      )
    )
      return unavailable;
    const authorized = ctx.userRequest?.trim() === `${label} on ${site}`;
    return { decision: authorized ? 'allowed' : 'ask', summary };
  }
  if (args.operation === 'key') {
    if (['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(args.key))
      return { decision: 'allowed', summary };
    if (
      args.key === 'Enter' &&
      target.role === 'textbox' &&
      target.actionKind === 'search' &&
      search.test(label)
    )
      return { decision: 'allowed', summary };
    if (!['Enter', 'Space'].includes(args.key)) return unavailable;
  }
  if (
    target.actionKind === 'navigation' ||
    target.actionKind === 'expand' ||
    (target.actionKind === 'search' && search.test(label))
  )
    return { decision: 'allowed', summary };
  return unavailable;
}
