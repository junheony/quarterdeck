import { latestRolloutRateLimits } from '../engine/codexRollout';
import type { UsageService } from './UsageService';

/**
 * F3: GPT usage without a deck GPT turn. On start and every `intervalMs`, the newest Codex rollout
 * files (any originator: Codex Desktop, CLI, deck) are tail-read for their last `token_count.rate_limits`,
 * which goes to the `gpt` seat with that event's own time. Reads rollouts only — never auth.json.
 */
export class CodexUsagePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAtMs = -Infinity;
  private running = false;
  private readonly intervalMs: number;
  private readonly read: typeof latestRolloutRateLimits;

  constructor(private readonly opts: { sessionsRoot: string; usage: Pick<UsageService, 'applyTurn'>; intervalMs?: number; read?: typeof latestRolloutRateLimits }) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.read = opts.read ?? latestRolloutRateLimits;
  }

  /** True when a new reading was applied. */
  async pollOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const obs = await this.read(this.opts.sessionsRoot);
      if (!obs || obs.atMs <= this.lastAtMs) return false;
      this.lastAtMs = obs.atMs;
      this.opts.usage.applyTurn('gpt', obs.windows, obs.atMs);
      return true;
    } catch (err) {
      console.error('deck: codex rollout usage read failed', err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
