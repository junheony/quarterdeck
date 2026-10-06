import { useEffect, useRef, useState } from 'react';
import { usePopoverPlacement } from './usePopoverPlacement';
import { AUTO_MODEL_INFO, EFFORTS, EFFORT_LABEL, MODEL_EFFORTS, MODEL_INFO, isCodexModel, isGeminiModel, type Effort, type ModelChoice } from '../../shared/models';

const MARGIN = 8;

const infoOf = (m: ModelChoice) => (m === 'auto' ? AUTO_MODEL_INFO : MODEL_INFO[m]);
const GAP = 6;

/**
 * Claude Desktop-style model menu: the button reads "Opus 5.5 · 높음"; the popover lists exact model versions
 * (grouped Claude / GPT when both are offered) and a reasoning-effort segment limited to what the model supports.
 * The popover is `position: fixed` and clamped to the viewport, so narrow split panes and phones never clip it.
 */
export function ModelPicker({ models, model, effort, onModel, onEffort }: {
  models: readonly ModelChoice[];
  model: ModelChoice;
  /** null = 자동 (only offered while the model is 자동). */
  effort: Effort | null;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const auto = model === 'auto';
  const efforts = auto ? EFFORTS : MODEL_EFFORTS[model];

  const pos = usePopoverPlacement(open, btnRef, popRef);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const claude = models.filter((m) => !isCodexModel(m) && !isGeminiModel(m));
  const gpt = models.filter((m) => isCodexModel(m));
  const gemini = models.filter((m) => isGeminiModel(m));
  const groups = [{ title: 'Claude', items: claude }, { title: 'GPT', items: gpt }, { title: 'Gemini', items: gemini }].filter((g) => g.items.length);
  const effortShown = effort !== null && efforts.includes(effort);
  const label = effortShown ? `${infoOf(model).name} · ${EFFORT_LABEL[effort]}` : infoOf(model).name;

  return (
    <span className="model-picker">
      <button
        ref={btnRef}
        type="button"
        className={`mp-button ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`모델: ${label}`}
        title="모델과 추론 수준"
        data-testid="model-picker"
        onClick={() => setOpen((o) => !o)}
      >
        {/* Name and effort as parts, so a narrow composer can drop the effort (it stays in the menu and the aria-label). */}
        <span className="mp-label">{infoOf(model).name}{effortShown && <span className="mp-label-extra"> {EFFORT_LABEL[effort]}</span>}</span>
        <span className="mp-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div ref={popRef} className="mp-pop" role="menu" aria-label="모델" style={pos} data-testid="model-menu">
          {groups.map((g) => (
            <div key={g.title} className="mp-section" role="group" aria-label={g.title}>
              {groups.length > 1 && <div className="mp-head">{g.title}</div>}
              {g.items.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m === model}
                  className={`mp-item ${m === model ? 'on' : ''}`}
                  onClick={() => onModel(m)}
                >
                  <span className="mp-text">
                    <span className="mp-name">{infoOf(m).name}</span>
                    <span className="mp-desc">{infoOf(m).description}</span>
                  </span>
                  <span className="mp-check" aria-hidden="true">{m === model ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          ))}
          {efforts.length > 0 && (
            <div className="mp-section" role="group" aria-label="추론 수준">
              <div className="mp-head">추론 수준</div>
              <div className="mp-effort">
                {auto && (
                  <button type="button" role="menuitemradio" aria-checked={effort === null} className={effort === null ? 'on' : ''} title="Sonnet 중간 · Opus/Fable 높음" onClick={() => onEffort(null)}>
                    자동
                  </button>
                )}
                {efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="menuitemradio"
                    aria-checked={e === effort}
                    className={e === effort ? 'on' : ''}
                    onClick={() => onEffort(e)}
                  >
                    {EFFORT_LABEL[e]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
