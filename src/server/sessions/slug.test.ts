import { describe, expect, it } from 'vitest';
import { projectSlug } from './slug';

describe('projectSlug', () => {
  it('replaces every non-alphanumeric character with a dash (per code point)', () => {
    expect(projectSlug('/Users/alice/Documents/작업/sample-project')).toBe('-Users-alice-Documents----sample-project');
    expect(projectSlug('/Users/alice/Documents/작업/Acme_app')).toBe('-Users-alice-Documents----Acme-app');
    expect(projectSlug('/private/tmp/claude-501/sdk-spike/work')).toBe('-private-tmp-claude-501-sdk-spike-work');
    expect(projectSlug('/Users/alice/Documents/작업/sample-project'.normalize('NFD'))).toBe('-Users-alice-Documents--------sample-project');
  });
});
