import { createContext, useContext } from 'react';
import { GEMINI_LABEL, LEGACY_ACCOUNTS, isGeminiAccount, type Account, type Seat } from '../shared/accounts';
import { accountInfos, type AccountInfo } from '../shared/protocol';

/** The account list of a server that sends none (before `hello.accounts`): a/b/c, a is home. */
export const LEGACY_ACCOUNT_LIST: readonly AccountInfo[] = accountInfos(LEGACY_ACCOUNTS);

/** `--acct-0` … `--acct-7` (styles.css). */
export const ACCOUNT_PALETTE_SIZE = 8;

/**
 * The store's account list from a hello. `list` is `hello.accounts` of a server with the 'accounts' feature
 * (undefined otherwise: the a/b/c defaults). Entries that are not an account are dropped; a list with none is no list.
 */
export function accountListOf(list: readonly AccountInfo[] | undefined): readonly AccountInfo[] {
  if (!Array.isArray(list)) return LEGACY_ACCOUNT_LIST;
  const seen = new Set<string>();
  const out: AccountInfo[] = [];
  for (const x of list as unknown[]) {
    if (x === null || typeof x !== 'object') continue;
    const { id, label, home, retired } = x as Partial<AccountInfo>;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: typeof label === 'string' && label ? label : id.toUpperCase(), home: home === true, retired: retired === true });
  }
  return out.length ? out : LEGACY_ACCOUNT_LIST;
}

/** `pin` when it names an account a turn can run on, else null (the server takes such a pin as none). */
export function activePin(list: readonly AccountInfo[], pin: Account | null | undefined): Account | null {
  return pin && list.some((a) => a.id === pin && !a.retired) ? pin : null;
}

/** Same accounts, same order, same facts. */
export function sameAccountList(a: readonly AccountInfo[], b: readonly AccountInfo[]): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => { const y = b[i]!; return x.id === y.id && x.label === y.label && x.home === y.home && x.retired === y.retired; }));
}

/** A seat's label: GPT, a Gemini account's, a configured Claude account's — and the id itself for one that is not configured. */
export function seatLabel(list: readonly AccountInfo[], seat: Seat): string {
  if (seat === 'gpt') return 'GPT';
  if (isGeminiAccount(seat)) return GEMINI_LABEL[seat];
  return list.find((a) => a.id === seat)?.label ?? String(seat);
}

/** What the UI knows about the Claude accounts (the server's registry, as far as hello carries it). */
export type UiAccounts = {
  /** Configured accounts, retired included, in configured order. */
  all: readonly AccountInfo[];
  /** The accounts a turn can run on (pickers, the usage cards). */
  active: readonly AccountInfo[];
  /** The profile Claude Desktop uses (null: the list names none). */
  home: AccountInfo | null;
  /** A configured account (active or retired). */
  has(id: unknown): id is Account;
  isRetired(id: Account): boolean;
  /** See `seatLabel`. */
  label(seat: Seat): string;
  /** Palette slot (`--acct-<n>`) by position in `all`; null for an id that is not configured, GPT and Gemini. */
  slot(seat: Seat): number | null;
  /** How a seat's tile is drawn: its palette slot, 'retired' (label, dimmed), 'unknown' (the id, grey) or 'other' (GPT, Gemini). */
  look(seat: Seat): { slot: number | null; kind: 'active' | 'retired' | 'unknown' | 'other' };
  /** The look in words, for titles and aria labels: '뺀 계정', '설정에 없는 계정', or null. */
  state(seat: Seat): string | null;
};

export function uiAccounts(list: readonly AccountInfo[]): UiAccounts {
  const at = new Map(list.map((a, i) => [a.id, i]));
  const get = (id: unknown): AccountInfo | undefined => (typeof id === 'string' ? list[at.get(id) ?? -1] : undefined);
  const slot = (seat: Seat): number | null => {
    const i = typeof seat === 'string' ? at.get(seat) : undefined;
    return i === undefined ? null : i % ACCOUNT_PALETTE_SIZE;
  };
  const look: UiAccounts['look'] = (seat) => {
    if (seat === 'gpt' || isGeminiAccount(seat)) return { slot: null, kind: 'other' };
    const a = get(seat);
    return { slot: slot(seat), kind: !a ? 'unknown' : a.retired ? 'retired' : 'active' };
  };
  return {
    all: list,
    active: list.filter((a) => !a.retired),
    home: list.find((a) => a.home) ?? null,
    has: (id: unknown): id is Account => get(id) !== undefined,
    isRetired: (id) => get(id)?.retired ?? false,
    label: (seat) => seatLabel(list, seat),
    slot,
    look,
    state: (seat) => { const k = look(seat).kind; return k === 'retired' ? '뺀 계정' : k === 'unknown' ? '설정에 없는 계정' : null; },
  };
}

export const LEGACY_UI_ACCOUNTS: UiAccounts = uiAccounts(LEGACY_ACCOUNT_LIST);

/** The connected server's accounts (App provides the store's list); a/b/c outside a provider. */
export const AccountsContext = createContext<UiAccounts>(LEGACY_UI_ACCOUNTS);

export function useAccounts(): UiAccounts {
  return useContext(AccountsContext);
}
