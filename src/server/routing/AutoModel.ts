import type { Account, AccountNames } from '../../shared/accounts';
import { AUTO_EFFORT, MODEL_INFO, type ClaudeModel, type Effort } from '../../shared/models';
import { usageOf, type UsageSnapshot } from '../../shared/usage-types';
import { WEEKLY_SWITCH_PCT, isLax, noFableWhy, rankCandidates } from './AccountRouter';

/**
 * 자동 모델: a cheap, deterministic difficulty guess for the FIRST turn of a new Claude session (never mid-session —
 * a model switch would throw away the prompt cache). No LLM call: length, attachment count and Korean/English
 * keyword cues. Order of precedence: hard (Fable) > medium (Opus) > easy (Sonnet).
 */

/** Design / architecture / security / unknown-cause debugging → Fable. */
const HARD: RegExp[] = [
  /설계|아키텍처|구조\s*(를|을)?\s*(잡|짜|바꾸|개편)|트레이드\s*오프|보안|취약점|위협\s*모델|권한\s*상승/,
  /원인\s*(불명|을?\s*모르)|이유를?\s*모르|왜\s*(그런지|인지)\s*모르|간헐적|가끔\s*(실패|죽|멈)|재현이?\s*안|경쟁\s*조건|교착|데드락|메모리\s*누수/,
  /되돌리기\s*어려|마이그레이션\s*전략|대규모\s*(개편|리팩터)/,
  /\barchitect(ure|ural)?\b|\bsystem design\b|\bdesign (a|the) (system|architecture|schema|protocol)\b|\btrade-?offs?\b/i,
  /\bsecurity\b|\bvulnerab|\bthreat model|\bexploit|\bprivilege escalation\b|\bauth(entication|orization)? flow\b/i,
  /\broot cause\b|\bno idea why\b|\bunknown cause\b|\bintermittent|\bflaky\b|\brace condition\b|\bdeadlock\b|\bmemory leak\b|\bheisenbug\b/i,
];

/** Implementation / multi-file / bug fixing → Opus. */
const MEDIUM: RegExp[] = [
  /구현|만들어|추가해|추가\s*(하|해)|작성해|개발해|리팩터|리팩토링|고쳐|수정해|버그|오류\s*(가|를)?\s*(나|고치)|에러|기능|여러\s*파일|연동|통합|테스트\s*(를)?\s*(작성|추가|짜)|마이그레이션/,
  /\bimplement|\bbuild\b|\badd (a |an |the )?(feature|endpoint|test|support)|\brefactor|\bfix\b|\bbug\b|\berror\b|\bcrash|\bmulti-?file|\bintegrat|\bmigrat|\bwrite (a |the )?(test|function|module|script)/i,
];

/** Short lookups, questions, renames, docs → Sonnet. */
const EASY: RegExp[] = [
  /뭐야|뭔가요|무엇|알려\s*줘|설명해|찾아\s*줘|어디|어떻게\s*해|이름\s*(을)?\s*바꿔|이름\s*변경|오타|문서|주석|요약|번역|목록|보여\s*줘|확인해\s*줘|\?$/,
  /\bwhat\b|\bwhere\b|\bhow (do|can) i\b|\bexplain\b|\brename\b|\btypo\b|\bdocs?\b|\bdocument|\bcomment|\bsummari[sz]e|\btranslate\b|\blist\b|\bshow me\b|\blook ?up\b/i,
];

/** Trivial edits: a short prompt with one of these is easy even though it says 고쳐/fix. */
const TRIVIAL = /오타|이름\s*(을)?\s*바꿔|이름\s*변경|주석|\btypo\b|\brename\b|\bcomment\b/i;

const hits = (res: RegExp[], text: string) => res.some((r) => r.test(text));

/** Prompt length (chars) above which a prompt counts as at least medium. */
export const LONG_PROMPT = 1500;
/** Prompt length (chars) at or below which a cue-less prompt counts as easy. */
export const SHORT_PROMPT = 200;

export type Difficulty = { model: ClaudeModel; why: string };

/** Pure classifier: which model the prompt deserves, before usage limits are considered. */
export function classifyPrompt(text: string, attachmentCount = 0): Difficulty {
  const t = text.trim();
  const len = t.length;
  const hard = hits(HARD, t);
  const medium = hits(MEDIUM, t);
  const easy = hits(EASY, t);
  if (hard) {
    // A short question that merely mentions a hard topic ("what is our architecture?") is a lookup, not design work.
    if (easy && !medium && len <= 120 && attachmentCount === 0) return { model: 'sonnet', why: '짧은 조회' };
    return { model: 'fable', why: '설계·보안·원인 불명' };
  }
  if (TRIVIAL.test(t) && len <= 120 && attachmentCount < 3) return { model: 'sonnet', why: '간단한 수정' };
  if (medium) return { model: 'opus', why: '구현·버그' };
  if (len > LONG_PROMPT) return { model: 'opus', why: '긴 요청' };
  if (attachmentCount >= 3) return { model: 'opus', why: `첨부 ${attachmentCount}개` };
  if (easy || len <= SHORT_PROMPT) return { model: 'sonnet', why: '짧은 조회' };
  return { model: 'opus', why: '일반 작업' };
}

export type AutoModelInput = {
  text: string;
  attachmentCount: number;
  usage: UsageSnapshot;
  nowMs: number;
  cooldownUntilMs: Partial<Record<Account, number>>;
  protectedAccount: Account | null;
  accounts: AccountNames;
};

export type AutoModelDecision = { model: ClaudeModel; effort: Effort; reason: string };

/**
 * Classifier + limits: Fable only when some account is Fable-eligible (Fable 7d < 80%, else Opus); when even the best
 * Claude account is at or above the weekly switch line (85%), step one tier down (Fable → Opus, Opus → Sonnet).
 * Unknown usage never steps down — the router has its own fallbacks.
 */
export function chooseAutoModel(i: AutoModelInput): AutoModelDecision {
  const c = classifyPrompt(i.text, i.attachmentCount);
  let model = c.model;
  const notes = [c.why];
  const base = { current: null, usage: i.usage, nowMs: i.nowMs, lastTurnAtMs: null, justCompacted: false, cooldownUntilMs: i.cooldownUntilMs, protectedAccount: i.protectedAccount, accounts: i.accounts };
  const forFable = model === 'fable' ? rankCandidates({ ...base, needFable: true }) : null;
  if (forFable && forFable.candidates.length === 0) {
    // Never had usage-deck: not knowing is no reason to leave Fable, nor is a cooldown (a real limit is handled by the turn's own fallback).
    const why = isLax(i.usage) && forFable.unknown.length > 0 ? null : noFableWhy(base);
    // "Unknown" is said only when some Fable value is unknown. With every value known (and below the limit), the
    // accounts are out for something else (5h/weekly limit, cooldown, a card that is down or stale), so the reason
    // names no cause — only that no account can take a Fable turn.
    const fableUnknown = i.accounts.list().some((a) => (usageOf(i.usage, a).fable?.usedPct ?? null) === null);
    if (why === null) {
      if (fableUnknown) notes.push('Fable 잔여량 모름');
    } else {
      model = 'opus';
      notes.push(why === 'Fable 여유 계정 없음' ? 'Fable 80%↑ → Opus' : fableUnknown ? `${why} → Opus` : 'Fable 로 쓸 수 있는 계정 없음 → Opus');
    }
  }
  const { candidates } = rankCandidates({ ...base, needFable: false });
  const best = candidates.length ? Math.min(...candidates.map((x) => x.weeklyPct)) : null;
  if (best !== null && best >= WEEKLY_SWITCH_PCT && model !== 'sonnet') {
    const down: ClaudeModel = model === 'fable' ? 'opus' : 'sonnet';
    notes.push(`주간 ${best}% → ${MODEL_INFO[down].name}`);
    model = down;
  }
  return { model, effort: AUTO_EFFORT[model], reason: `자동 → ${MODEL_INFO[model].name} · ${notes.join(' · ')}` };
}
