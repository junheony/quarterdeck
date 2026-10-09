import { describe, expect, it } from 'vitest';
import { CODEX_CLI_MODEL, CODEX_MODELS, MODEL_INFO, DEFAULT_CODEX_MODEL, DEFAULT_SANDBOX, MODEL_LABEL, SANDBOX_LABEL, defaultGeminiSandbox, isCodexModel } from './models';

describe('sandbox defaults (D2, 다 붙여)', () => {
  it('GPT: workspace-write with network is the default and says so; Gemini keeps plan unless 자동 승인', () => {
    expect(DEFAULT_SANDBOX).toBe('workspace-write');
    expect(SANDBOX_LABEL['workspace-write']).toBe('작업폴더 쓰기 · 네트워크');
    expect(defaultGeminiSandbox(false)).toBe('read-only');
    expect(defaultGeminiSandbox(true)).toBe('workspace-write');
  });
});

describe('codex models (D1)', () => {
  it('only sol and astra; sol is the default; luna/terra/5.5/gpt-5.6-sol are not models', () => {
    expect(CODEX_MODELS).toEqual(['gpt-6-sol', 'gpt-6-astra']);
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6-sol');
    for (const bad of ['gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5', 'haiku']) expect(isCodexModel(bad)).toBe(false);
    expect(isCodexModel('gpt-6-astra')).toBe(true);
    expect(MODEL_LABEL['gpt-6-sol']).toBe('GPT Sol');
    expect(MODEL_LABEL.opus).toBe('Opus');
    expect(SANDBOX_LABEL['read-only']).toBe('읽기 전용');
  });

  it('Sol goes to the CLI as gpt-6.1-sol; the deck id stays gpt-6-sol', () => {
    expect(CODEX_CLI_MODEL).toEqual({ 'gpt-6-sol': 'gpt-6.1-sol', 'gpt-6-astra': 'gpt-6-astra' });
    expect(MODEL_INFO['gpt-6-sol'].name).toBe('GPT-6.1-Sol');
    expect(isCodexModel('gpt-6.1-sol')).toBe(false);
  });
});
