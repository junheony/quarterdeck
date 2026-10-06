// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canTakeFocus, composerOf, focusComposer, routeContext, routeKey } from './composerFocus';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number; defaultPrevented: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
const idle = { typing: false, popupOpen: false };

describe('routeKey (type-to-compose)', () => {
  it('printable ASCII is typed into the composer', () => {
    for (const k of ['a', 'Z', '1', '?', '~']) expect(routeKey(key(k), idle)).toBe('type');
  });
  it('IME / non-ASCII keys only move focus (swallowed), so a composition never garbles', () => {
    for (const k of ['ㅎ', '한', 'é', '😀', 'Process']) expect(routeKey(key(k), idle)).toBe('focus');
    expect(routeKey(key('a', { isComposing: true }), idle)).toBe('focus');
    expect(routeKey(key('Unidentified', { keyCode: 229 }), idle)).toBe('focus');
  });
  it('Space keeps its page behaviour (scroll / press the focused button); non-printable keys are left alone', () => {
    for (const k of [' ', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'F5', 'Dead', 'Shift', 'Backspace']) expect(routeKey(key(k), idle)).toBeNull();
  });
  it('ignores ⌘ / Ctrl / Alt and handled keys', () => {
    expect(routeKey(key('k', { metaKey: true }), idle)).toBeNull();
    expect(routeKey(key('k', { ctrlKey: true }), idle)).toBeNull();
    expect(routeKey(key('k', { altKey: true }), idle)).toBeNull();
    expect(routeKey(key('ㅎ', { altKey: true }), idle)).toBeNull();
    expect(routeKey(key('a', { defaultPrevented: true }), idle)).toBeNull();
  });
  it('ignores keys while typing elsewhere or with a palette / menu / dialog open', () => {
    expect(routeKey(key('a'), { ...idle, typing: true })).toBeNull();
    expect(routeKey(key('ㅎ', { keyCode: 229 }), { ...idle, typing: true })).toBeNull();
    expect(routeKey(key('a'), { ...idle, popupOpen: true })).toBeNull();
  });
});

describe('composer focus', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const setup = () => {
    document.body.innerHTML = `
      <section data-pane="p1"><div class="composer"><textarea id="c1">draft</textarea></div><textarea id="edit"></textarea><button id="b">x</button></section>
      <section data-pane="p2"><div class="newchat"><textarea id="c2"></textarea></div></section>`;
    return (id: string) => document.getElementById(id) as HTMLTextAreaElement;
  };

  it('finds each pane\'s composer (chat or new-chat screen)', () => {
    const $ = setup();
    expect(composerOf('p1')).toBe($('c1'));
    expect(composerOf('p2')).toBe($('c2'));
    expect(composerOf('p9')).toBeNull();
  });

  it('focuses the composer with the caret at the end, only on a fine pointer', () => {
    const $ = setup();
    expect(focusComposer('p1', { fine: false })).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(focusComposer('p1', { fine: true })).toBe(true);
    expect(document.activeElement).toBe($('c1'));
    expect($('c1').selectionStart).toBe(5);
  });

  it('never takes focus out of a field being edited, nor over a menu / palette', () => {
    const $ = setup();
    $('edit').focus();
    expect(canTakeFocus()).toBe(false);
    expect(focusComposer('p1', { fine: true })).toBe(false);
    expect(document.activeElement).toBe($('edit'));
    // Another pane's composer keeps its caret; the target composer itself, or a button just clicked: fine.
    $('c2').focus();
    expect(canTakeFocus()).toBe(false);
    expect(focusComposer('p1', { fine: true })).toBe(false);
    expect(document.activeElement).toBe($('c2'));
    expect(canTakeFocus(document, $('c2'))).toBe(true);
    $('b').focus();
    expect(canTakeFocus()).toBe(true);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    expect(canTakeFocus()).toBe(false);
    menu.remove();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    expect(focusComposer('p1', { fine: true })).toBe(false);
  });

  it('routeContext reads typing / popups from the DOM', () => {
    const $ = setup();
    expect(routeContext(document.body)).toEqual({ typing: false, popupOpen: false });
    expect(routeContext($('edit')).typing).toBe(true);
  });
});
