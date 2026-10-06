import type { RoleEntry } from '../roles';

/** D9 role distribution as a small muted inline line, not a box. */
export function RoleBadge({ roles }: { roles: RoleEntry[] }) {
  if (!roles.length) return null;
  const agents = roles.filter((r) => r.kind === 'agent').length;
  const offloads = roles.length - agents;
  return (
    <div className="role-badge">
      <span className="role-summary">역할 분배: 서브에이전트 {agents} · offload {offloads}</span>
      {roles.map((r, i) => r.kind === 'agent'
        ? <span key={i} className="chip agent" title={r.description}>{r.type} · {r.model ?? '기본 모델'}</span>
        : <span key={i} className="chip offload" title={r.command}>offload {r.cross ? 'cross' : (r.model ?? '자동')}</span>)}
    </div>
  );
}
