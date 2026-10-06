import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { initialState, reducer, type AppState } from './state';

const play = (msgs: ServerMessage[], start: AppState = initialState): AppState => msgs.reduce((s, m) => reducer(s, { type: 'server', msg: m }), start);

describe('routingPolicy (server setting)', () => {
  it('null until the server says; hello/settings set it; an older server without the field means balance', () => {
    expect(initialState.routingPolicy).toBeNull();
    let s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'drain' } }]);
    expect(s.routingPolicy).toBe('drain');
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' } }], s);
    expect(s.routingPolicy).toBe('balance');
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'drain' } }], s);
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions' } }], s);
    expect(s.routingPolicy).toBe('balance');
  });
});
