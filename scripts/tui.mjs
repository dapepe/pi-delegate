/** Dependency-free terminal view for stats.mjs. */

import process from 'node:process';

const ESC = '\u001b';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\u001b]*(?:\u001b\\))/g;
export const TABS = Object.freeze(['Overview', 'Models', 'Focus areas', 'Tasks', 'Learning']);

export function sanitizeTerminalText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const clean = String(value).replace(ANSI, '').replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim();
  return clean || fallback;
}

function text(value, fallback = '--') { return sanitizeTerminalText(value, fallback); }
function num(value, fallback = '--') { return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback; }
function usd(value) { return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(4)}` : '--'; }
function pct(known, total) {
  return Number.isFinite(known) && Number.isFinite(total) && total > 0 ? `${Math.round((known / total) * 100)}%` : '--';
}

function tokenCoverage(tokens, key, requestCount) {
  const known = Number.isInteger(tokens?.[`${key}_known`]) ? Math.max(0, tokens[`${key}_known`]) : 0;
  const denominator = Number.isFinite(requestCount) ? Math.max(0, requestCount)
    : (Number.isInteger(tokens?.requests) ? Math.max(0, tokens.requests) : 0);
  const value = known > 0 && typeof tokens?.[key] === 'number' && Number.isFinite(tokens[key]) ? num(tokens[key]) : '--';
  return `${value} (${known}/${denominator})`;
}

function ansi(code, value, color) { return color ? `${ESC}[${code}m${value}${ESC}[0m` : value; }
function strong(value, color) { return ansi('1;96', value, color); }
function muted(value, color) { return ansi('2;37', value, color); }
function amber(value, color) { return ansi('33', value, color); }
function selected(value, color) { return ansi('30;46', value, color); }

function visibleText(value) { return String(value ?? '').replace(ANSI, '').replace(CONTROL, ' '); }
function charWidth(value) {
  // Keep the budget conservative for combining marks and zero-width joiners;
  // Array.from avoids splitting surrogate pairs.
  if (!value || /^\p{Mark}$/u.test(value) || value === '\u200d' || value === '\ufe0e' || value === '\ufe0f') return 0;
  return 1;
}
function visibleLength(value) { return Array.from(visibleText(value)).reduce((total, character) => total + charWidth(character), 0); }
function truncate(value, width) {
  const source = String(value ?? '');
  const limit = Math.max(0, Math.floor(width));
  if (limit <= 0) return '';
  if (visibleLength(source) <= limit) return source;
  const target = Math.max(0, limit - 1);
  let output = '';
  let cursor = 0;
  let used = 0;
  let match;
  ANSI.lastIndex = 0;
  while (cursor < source.length && used < target) {
    ANSI.lastIndex = cursor;
    match = ANSI.exec(source);
    const end = match ? match.index : source.length;
    const chunk = source.slice(cursor, end).replace(CONTROL, ' ');
    for (const character of Array.from(chunk)) {
      const columns = charWidth(character);
      if (columns && used + columns > target) break;
      output += character;
      used += columns;
    }
    if (used >= target || !match) break;
    output += match[0];
    cursor = match.index + match[0].length;
  }
  // A clipped styled value must not bleed its style into the rest of the
  // frame. The renderer uses SGR only, so a reset is sufficient here.
  return `${output}…${source.includes(ESC) ? `${ESC}[0m` : ''}`;
}

function pad(value, width) {
  const limit = Math.max(0, Math.floor(width));
  const used = visibleLength(value);
  if (used > limit) return truncate(value, limit);
  return `${value ?? ''}${' '.repeat(Math.max(0, limit - used))}`;
}

function bars(value, max, width) {
  const n = Number.isFinite(value) ? Math.max(0, Math.min(max || 1, value)) : 0;
  const filled = max > 0 ? Math.round((n / max) * width) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function spark(values, width = 18, color = true) {
  const glyphs = color ? '▁▂▃▄▅▆▇█' : '.,:;irsXA253hMHGS#9B&@';
  const clean = (values || []).filter(value => Number.isFinite(value));
  if (!clean.length) return '·'.repeat(width);
  const max = Math.max(...clean, 1), min = Math.min(...clean);
  const sample = clean.length > width ? clean.slice(-width) : clean;
  return sample.map(value => glyphs[Math.min(glyphs.length - 1, Math.round(((value - min) / Math.max(1, max - min)) * (glyphs.length - 1)))]).join('').padStart(width, '·');
}

function costSummary(value) {
  const costs = value && typeof value === 'object' ? value : {};
  const known = costs.known_usd ?? costs.provider_reported_usd;
  const estimated = costs.estimated_usd ?? costs.estimated_unreconciled_usd;
  const unknown = costs.unknown_charge_requests ?? costs.unpriced_request_count;
  return `cost ${usd(known)} · est ${usd(estimated)} · unknown ${num(unknown, '0')}`;
}

function taskCostSummary(row) {
  const total = { known_usd: 0, estimated_usd: 0, unknown_charge_requests: 0, known: false, estimated: false };
  for (const attempt of row?.attempts || []) {
    const costs = attempt.costs || {};
    const known = costs.known_usd ?? costs.provider_reported_usd;
    const estimated = costs.estimated_usd ?? costs.estimated_unreconciled_usd;
    const unknown = costs.unknown_charge_requests ?? costs.unpriced_request_count;
    if (typeof known === 'number' && Number.isFinite(known)) { total.known_usd += known; total.known = true; }
    if (typeof estimated === 'number' && Number.isFinite(estimated)) { total.estimated_usd += estimated; total.estimated = true; }
    if (typeof unknown === 'number' && Number.isFinite(unknown)) total.unknown_charge_requests += unknown;
  }
  return costSummary({
    known_usd: total.known ? Number(total.known_usd.toFixed(4)) : null,
    estimated_usd: total.estimated ? Number(total.estimated_usd.toFixed(4)) : null,
    unknown_charge_requests: total.unknown_charge_requests
  });
}

function projectLabel(data, projectIndex = null) {
  const projects = data.selection?.projects || [];
  if (!projects.length) return 'No project selected';
  if (projects.length === 1) {
    const p = projects[0];
    return `${text(p.project_name)} · ${text(p.path)}`;
  }
  if (Number.isInteger(projectIndex) && projectIndex >= 0 && projectIndex < projects.length) {
    const p = projects[projectIndex];
    return `Project ${projectIndex + 1}/${projects.length}: ${text(p.project_name)} (${text(p.project_id || p.path)}) · combined view available with p`;
  }
  return `All ${projects.length} selected projects · ${projects.map(p => `${text(p.project_name)} (${text(p.project_id || p.path)})`).join(', ')}`;
}

function projectLimit(data) {
  const count = data?.selection?.projects?.length || 0;
  return count > 1 ? count : 0;
}

function box(lines, width, color) {
  const unicode = color;
  const left = unicode ? '│' : '|';
  const topLeft = unicode ? '╭' : '+';
  const topRight = unicode ? '╮' : '+';
  const bottomLeft = unicode ? '╰' : '+';
  const bottomRight = unicode ? '╯' : '+';
  const horizontal = unicode ? '─' : '-';
  const bodyWidth = Math.max(1, width - 2);
  const out = [`${topLeft}${horizontal.repeat(bodyWidth)}${topRight}`];
  for (const line of lines) out.push(`${left}${pad(line, bodyWidth)}${left}`);
  out.push(`${bottomLeft}${horizontal.repeat(bodyWidth)}${bottomRight}`);
  return out;
}

function summaryCards(data, width, color) {
  const summary = data.summary || {};
  const costs = data.costs || {};
  const quality = summary.quality || {};
  const usefulness = summary.usefulness || {};
  const cards = [
    [`ASSIGNMENTS ${num(summary.latest_assignments, '0')}`, `tasks ${num(summary.distinct_tasks, '0')} · ${num(summary.latest_completed, '0')} complete`, `coverage ${pct(summary.assessed_coverage?.usefulness, summary.latest_assignments)}`],
    [`QUALITY ${quality.mean === null || quality.mean === undefined ? '--' : `${quality.mean}/3`}`, `${num(quality.assessed, '0')}/${num(quality.denominator, '0')} tasks assessed`, `quality is descriptive`],
    [`USEFULNESS ${usefulness.mean === null || usefulness.mean === undefined ? '--' : `${usefulness.mean}/3`}`, `${num(usefulness.assessed, '0')}/${num(usefulness.denominator, '0')} tasks assessed`, `latest assignment only`],
    [`SPEND ${costs.known_usd === undefined ? '--' : `$${Number(costs.known_usd).toFixed(4)}`}`, `est $${Number(costs.estimated_usd || 0).toFixed(4)} · unknown ${num(costs.unknown_charge_requests, '0')}`, `requests ${num(costs.request_count, '0')}`]
  ];
  // Four cards fit at a desktop width, two cards at a medium width, and a
  // compact one-line summary keeps narrow terminals useful instead of
  // rendering four clipped boxes side by side.
  if (width < 70) {
    const compact = [
      `A ${num(summary.latest_assignments, '0')} · ${num(summary.distinct_tasks, '0')} tasks · ${num(summary.latest_completed, '0')} complete`,
      `Q ${quality.mean === null || quality.mean === undefined ? '--' : `${quality.mean}/3`} · ${num(quality.assessed, '0')}/${num(quality.denominator, '0')} assessed`,
      `U ${usefulness.mean === null || usefulness.mean === undefined ? '--' : `${usefulness.mean}/3`} · ${num(usefulness.assessed, '0')}/${num(usefulness.denominator, '0')} assessed`,
      `S ${costs.known_usd === undefined ? '--' : `$${Number(costs.known_usd).toFixed(4)}`} · est $${Number(costs.estimated_usd || 0).toFixed(4)} · ? ${num(costs.unknown_charge_requests, '0')}`
    ];
    return compact.map((line, index) => index === 3 ? amber(truncate(line, width), color) : muted(truncate(line, width), color));
  }
  const columns = width >= 110 ? 4 : 2;
  const gap = 1;
  const cardWidth = Math.max(3, Math.floor((width - gap * (columns - 1)) / columns));
  const rows = [];
  for (let i = 0; i < cards.length; i += columns) {
    const current = cards.slice(i, i + columns);
    const rendered = current.map(card => box(card.map((line, index) => index === 0 ? strong(line, color) : muted(line, color)), cardWidth, color));
    const max = Math.max(...rendered.map(lines => lines.length));
    for (let row = 0; row < max; row++) rows.push(rendered.map((lines, index) => {
      const line = lines[row] || '';
      return index === rendered.length - 1 ? line : pad(line, cardWidth);
    }).join(' '.repeat(gap)));
  }
  return rows;
}

function learningProjectRows(data) {
  const learning = data.learning && typeof data.learning === 'object' ? data.learning : {};
  if (Array.isArray(learning.projects) && learning.projects.length) {
    const selected = data.selection?.projects?.[0];
    const source = selected && data.selection?.projects?.length === 1 && learning.projects.length > 1
      ? learning.projects.filter(project => (selected.project_id && project.project_id === selected.project_id) || (selected.path && project.path === selected.path))
      : learning.projects;
    return (source.length ? source : learning.projects).map((project, index) => ({
      ...project,
      label: project.label || project.project_name || project.project_id || `Project ${index + 1}`,
      project_name: project.project_name || project.name || project.label || project.project_id || `Project ${index + 1}`,
      status: project.status || project.lifecycle || project.lifecycle_status || 'unknown',
      next_action: project.next_action || project.next || project.action || 'unknown'
    }));
  }
  // A project view may carry one learning state directly rather than wrapping
  // it in `projects`. Preserve that shape for the selected-project view.
  if (['mode', 'status', 'next_action', 'next', 'initialized', 'project_id', 'project_name'].some(key => Object.hasOwn(learning, key))) {
    const project = data.selection?.projects?.[0] || {};
    return [{
      ...learning,
      label: learning.label || learning.project_name || project.project_name || project.project_id || 'Selected project',
      project_name: learning.project_name || project.project_name || project.project_id || 'Selected project',
      project_id: learning.project_id || project.project_id || null,
      status: learning.status || learning.lifecycle || learning.lifecycle_status || 'unknown',
      next_action: learning.next_action || learning.next || learning.action || 'unknown'
    }];
  }
  return [];
}

function isLearningProjectRow(row) {
  return Boolean(row && (Object.hasOwn(row, 'mode') || Object.hasOwn(row, 'status') || Object.hasOwn(row, 'next_action') || Object.hasOwn(row, 'initialized')));
}

function selectedCollection(state) {
  const data = viewData(state);
  const tab = state.tab ?? 0;
  if (tab === 1) return data.models || [];
  if (tab === 2) return data.focus_areas || [];
  if (tab === 3) return data.tasks || [];
  if (tab === 4) {
    const projects = learningProjectRows(data);
    return projects.length ? projects : [...(data.models || []), ...(data.focus_areas || [])];
  }
  return [];
}

function viewData(state) {
  const data = state.data || state;
  const projects = data.selection?.projects || [];
  const index = state.projectIndex;
  if (Array.isArray(data.project_views) && Number.isInteger(index) && index >= 0 && index < projects.length) {
    return data.project_views[index] || data;
  }
  return data;
}

function rowLabel(tab, row) {
  if (tab === 1) return `${text(row.label || `${row.model?.provider}/${row.model?.resolved_model}`)} · ${text(row.role, 'unknown')}`;
  if (tab === 2) return `${text(row.tag, 'unspecified')} · ${row.assignments || 0} assignment(s)`;
  if (tab === 3) return `${text(row.task_id, 'unknown task')}${row.task_label ? ` · ${text(row.task_label)}` : ''}`;
  if (tab === 4) return text(row.label || row.project_name || row.project_id || row.tag || row.task_id, 'learning item');
  return 'Overview';
}

function rowMeta(tab, row) {
  if (tab === 1) return `Q ${row.quality?.mean ?? '--'}/3 · U ${row.usefulness?.mean ?? '--'}/3 · tasks ${row.distinct_tasks ?? 0} · ${costSummary(row.costs)}`;
  if (tab === 2) return `tasks ${row.distinct_tasks ?? 0} · quality ${row.quality?.mean ?? '--'}/3 · usefulness ${row.usefulness?.mean ?? '--'}/3`;
  if (tab === 3) {
    const latest = row.latest || {};
    return `${text(latest.status)} · ${text(latest.model?.resolved_model)} · attempts ${row.attempts?.length || 0}`;
  }
  if (tab === 4) {
    if (isLearningProjectRow(row)) return `mode ${text(row.mode, 'unknown')} · ${text(row.status, 'unknown')} · next ${text(row.next_action, 'unknown')}`;
    return row.profile_key ? `model evidence · ${row.distinct_tasks ?? 0} task(s)` : `focus evidence · ${row.assignments ?? 0} assignment(s)`;
  }
  return '';
}

function detailLines(tab, row) {
  if (!row) return ['Select a row for details.'];
  if (tab === 1) return [
    `Model: ${text(row.model?.provider)}/${text(row.model?.resolved_model)}`,
    `Identity: ${text(row.model?.model_identity)} · requested ${text(row.model?.requested_model)}`,
    `Host: ${text(row.model?.host)} · effort ${text(row.model?.effective_effort)} · mode ${text(row.model?.mode)}`,
    `Tasks: ${row.distinct_tasks ?? '--'} · latest ${row.latest_assignments ?? '--'} · retries ${row.retry_attempts ?? '--'}`,
    `Quality: ${row.quality?.mean ?? '--'}/3 (${row.quality?.assessed ?? 0}/${row.quality?.denominator ?? 0}) · usefulness ${row.usefulness?.mean ?? '--'}/3 (${row.usefulness?.assessed ?? 0}/${row.usefulness?.denominator ?? 0})`,
    `Spend: ${costSummary(row.costs)}`,
    row.raw_evidence_available ? 'Reasons: raw assessment available' : 'Reasons: raw assessment unavailable'
  ];
  if (tab === 2) return [
    `Focus: ${text(row.tag)}`, `Assignments: ${row.assignments ?? '--'} · tasks ${row.distinct_tasks ?? '--'}`,
    `Quality: ${row.quality?.mean ?? '--'}/3 (${row.quality?.assessed ?? 0}/${row.quality?.denominator ?? 0})`,
    `Usefulness: ${row.usefulness?.mean ?? '--'}/3 (${row.usefulness?.assessed ?? 0}/${row.usefulness?.denominator ?? 0})`,
    row.raw_evidence_available ? 'Raw reasons available' : 'Raw reasons unavailable'
  ];
  if (tab === 3) {
    const latest = row.latest || {};
    return [`Task: ${text(row.task_id)}${row.task_label ? ` · ${text(row.task_label)}` : ''}`, `Project: ${text(row.project_name)} · ${text(row.repo_path)}`,
      `Latest: ${text(latest.status)} · ${text(latest.at)}${latest.stale_checkpoint ? ' · stale checkpoint' : ''}`,
      `Model: ${text(latest.model?.provider)}/${text(latest.model?.resolved_model)} · effort ${text(latest.model?.effective_effort)}`,
      `Assessment: quality ${latest.quality_0_to_3 ?? '--'}/3 · usefulness ${latest.usefulness_0_to_3 ?? '--'}/3`,
      `Attempts: ${row.attempts?.length || 0} · ${taskCostSummary(row)}`,
      latest.reason ? `Reason: ${text(latest.reason)}` : 'Reason: unavailable'];
  }
  if (isLearningProjectRow(row)) return [
    `Project: ${text(row.project_name || row.project_id || row.label)}`,
    `Mode: ${text(row.mode, 'unknown')} · initialized ${row.initialized === undefined ? '--' : row.initialized ? 'yes' : 'no'}`,
    `Status: ${text(row.status, 'unknown')}`,
    `Next action: ${text(row.next_action, 'unknown')}`,
    `Coverage: ${row.assessed_coverage?.total ?? row.coverage ?? '--'} assignment(s)`,
    'Evidence is observational and host-reviewed.'
  ];
  return [`${row.label || row.tag || '--'}`, `Evidence is observational and host-reviewed.`, `Usefulness ${row.usefulness?.mean ?? '--'}/3 · quality ${row.quality?.mean ?? '--'}/3`];
}

function contentLines(state, width, height, color) {
  const data = viewData(state);
  const tab = state.tab ?? 0;
  const collection = selectedCollection(state).filter(row => {
    const query = state.search || '';
    return !query || rowLabel(tab, row).toLowerCase().includes(query.toLowerCase());
  });
  const selectedIndex = collection.length ? Math.max(0, Math.min(collection.length - 1, state.selected ?? 0)) : 0;
  const selectedRow = collection[selectedIndex];
  const lines = [];
  if (tab === 0) {
    lines.push(...summaryCards(data, width, color));
    lines.push('', strong('Activity', color), `${muted('attempts per recent task', color)} ${spark((data.tasks || []).slice(0, 18).map(task => task.attempts?.length || 0), Math.min(24, Math.max(8, width - 28)), color)}`);
    lines.push('', `${muted('Status', color)} completed ${num(data.summary?.latest_completed, '0')} · failed ${num(data.summary?.latest_failed, '0')} · incomplete ${num(data.summary?.latest_incomplete, '0')} · ${amber(`stale ${num(data.summary?.stale_checkpoints, '0')}`, color)}`);
    lines.push(`${muted('Assessment', color)} quality ${num(data.summary?.quality?.assessed, '0')}/${num(data.summary?.quality?.denominator, '0')} · usefulness ${num(data.summary?.usefulness?.assessed, '0')}/${num(data.summary?.usefulness?.denominator, '0')} · unknown assignment metadata ${num(data.summary?.assignment_metadata_missing, '0')}`);
    const tokens = data.costs?.token_totals || {};
    if (Object.keys(tokens).length) {
      const requestCount = Number.isFinite(data.costs?.request_count) ? data.costs.request_count : tokens.requests;
      lines.push(`${muted('Tokens', color)} input ${tokenCoverage(tokens, 'input', requestCount)} · output ${tokenCoverage(tokens, 'output', requestCount)} · reasoning ${tokenCoverage(tokens, 'reasoning', requestCount)}`);
      lines.push(`${muted('Token cache', color)} read ${tokenCoverage(tokens, 'cache_read', requestCount)} · write ${tokenCoverage(tokens, 'cache_write', requestCount)} · total ${tokenCoverage(tokens, 'total', requestCount)}`);
    }
    lines.push('', strong('Selected project context', color), text(projectLabel(data, state.projectIndex)));
    return lines;
  }
  lines.push(`${strong(TABS[tab], color)}${state.search ? ` · search: ${text(state.search)}` : ''}`, '');
  if (!collection.length) lines.push(muted('No matching evidence in this window.', color));
  else {
    const listWidth = width >= 94 ? Math.floor(width * 0.53) : width;
    const detailWidth = width - listWidth - 3;
    if (state.detail && selectedRow) return box(detailLines(tab, selectedRow), width, color);
    const maxRows = Math.max(1, Math.floor((height - 10) / 2));
    const start = Math.max(0, Math.min(Math.max(0, collection.length - maxRows), selectedIndex - maxRows + 1));
    const visibleRows = collection.slice(start, start + maxRows);
    const listLines = visibleRows.map((row, offset) => {
      const index = start + offset;
      const prefix = index === selectedIndex ? '> ' : '  ';
      const label = `${prefix}${rowLabel(tab, row)}`;
      const meta = rowMeta(tab, row);
      const formatted = `${truncate(label, Math.max(8, listWidth - 2))}\n${muted(`  ${truncate(meta, Math.max(8, listWidth - 4))}`, color)}`;
      return index === selectedIndex ? selected(formatted, color) : formatted;
    });
    if (width >= 94 && detailWidth >= 28) {
      const detail = box(detailLines(tab, selectedRow), detailWidth, color);
      const max = Math.max(listLines.length, detail.length);
      for (let i = 0; i < max; i++) lines.push(`${pad(listLines[i] || '', listWidth)} ${detail[i] || ''}`);
    } else {
      lines.push(...listLines);
      lines.push('', ...box(detailLines(tab, selectedRow), width, color));
    }
  }
  return lines;
}

/** Pure deterministic renderer used by tests and host visual inspection. */
export function renderFrame(state, width = 100, height = 32, { color = false } = {}) {
  const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 100);
  const safeHeight = Math.max(1, Number.isFinite(height) ? Math.floor(height) : 32);
  const data = state.data || state;
  const tab = Math.max(0, Math.min(TABS.length - 1, state.tab ?? 0));
  const tabs = TABS.map((label, index) => index === tab ? selected(` ${index + 1} ${label} `, color) : muted(` ${index + 1} ${label} `, color)).join(' ');
  const controls = safeWidth < 70
    ? '←→ tabs · j/k move · enter detail · / search · p project · r reload · q quit'
    : '↑↓/jk move  enter details  esc back  / search  p project  r reload  q quit';
  const header = [
    `${strong('PI', color)} ${strong('STATISTICS', color)}  ${text(projectLabel(data, state.projectIndex))}`,
    `${muted(`Period ${text(data.period?.name)} · ${text(data.period?.start)} → ${text(data.period?.end)} · ${text(data.generated_at)}`, color)}`,
    tabs,
    `${muted(controls, color)}`
  ];
  const frame = [...header, '', ...contentLines({ ...state, tab }, safeWidth, safeHeight, color)];
  const clipped = frame.slice(0, safeHeight);
  return clipped.map(line => {
    const clean = line.replace(/\n/g, ' ');
    const visible = visibleLength(clean);
    if (visible <= safeWidth) return clean;
    const shortened = truncate(clean, safeWidth);
    return visibleLength(shortened) <= safeWidth ? shortened : truncate(shortened, safeWidth);
  }).join('\n');
}

function keyName(input) {
  if (input === 'enter') return 'enter';
  if (input === 'esc' || input === 'escape') return 'back';
  if (input === 'ctrl-c') return 'quit';
  if (input === '\u0003' || input === 'q') return 'quit';
  if (input === '\u001b[A' || input === 'k') return 'up';
  if (input === '\u001b[B' || input === 'j') return 'down';
  if (input === '\u001b[C') return 'right';
  if (input === '\u001b[D') return 'left';
  if (input === '\r' || input === '\n') return 'enter';
  if (input === '\u001b') return 'back';
  if (input === '\t') return 'tab';
  if (input === '/') return 'search';
  if (input === 'p') return 'project';
  if (input === 'r') return 'reload';
  if (/^[1-5]$/.test(input)) return `tab${input}`;
  if (input === '\u007f') return 'backspace';
  return null;
}

export function createTuiController(initial, { reload = null, onExit = null, onChange = null } = {}) {
  const state = { data: initial, tab: 0, selected: 0, projectIndex: projectLimit(initial), search: '', searching: false, detail: false, exited: false, reloading: false, reload_error: null };
  const selectedCount = () => selectedCollection(state).filter(row => !state.search || rowLabel(state.tab, row).toLowerCase().includes(state.search.toLowerCase())).length;
  const move = delta => { const count = selectedCount(); state.selected = count ? (state.selected + delta + count) % count : 0; };
  const render = (width = 100, height = 32, options = {}) => renderFrame(state, width, height, options);
  const exit = () => { if (state.exited) return; state.exited = true; onExit?.(state); };
  const setData = next => {
    if (!next) { state.reloading = false; onChange?.(state); return state; }
    const wasCombined = state.projectIndex === projectLimit(state.data);
    state.data = next;
    state.projectIndex = wasCombined ? projectLimit(next) : Math.min(state.projectIndex, projectLimit(next));
    state.selected = 0;
    state.detail = false;
    state.reloading = false;
    state.reload_error = null;
    onChange?.(state);
    return state;
  };
  const reloadData = () => {
    if (!reload || state.reloading) return;
    state.reloading = true;
    state.reload_error = null;
    onChange?.(state);
    try {
      const value = reload(state.data);
      if (value && typeof value.then === 'function') {
        value.then(next => setData(next)).catch(error => {
          state.reloading = false;
          state.reload_error = sanitizeTerminalText(error?.message, 'reload failed');
          onChange?.(state);
        });
      } else setData(value);
    } catch (error) {
      state.reloading = false;
      state.reload_error = sanitizeTerminalText(error?.message, 'reload failed');
      onChange?.(state);
    }
  };
  const handleKey = input => {
    if (state.exited) return { state, action: 'exited' };
    // While searching, printable characters are data. This keeps q/j/p/r and
    // tab digits from accidentally invoking global commands.
    if (state.searching) {
      if (input === '\u007f') { state.search = state.search.slice(0, -1); return { state, action: 'search' }; }
      if (input === '\r' || input === '\n' || input === 'enter' || input === '\u001b' || input === 'esc' || input === 'escape') { state.searching = false; state.selected = 0; return { state, action: 'search' }; }
      if (typeof input === 'string' && input.length === 1 && input.charCodeAt(0) >= 32 && input.charCodeAt(0) !== 127) { state.search += sanitizeTerminalText(input, ''); return { state, action: 'search' }; }
    }
    const key = keyName(input);
    if (key === 'quit') { exit(); return { state, action: 'quit' }; }
    if (key === 'up') move(-1);
    else if (key === 'down') move(1);
    else if (key === 'left' || key === 'back') state.detail = false;
    else if (key === 'enter') state.detail = true;
    else if (key === 'tab' || key === 'right') { state.tab = (state.tab + 1) % TABS.length; state.selected = 0; state.detail = false; }
    else if (key?.startsWith('tab')) { state.tab = Number(key.slice(3)) - 1; state.selected = 0; state.detail = false; }
    else if (key === 'search') { state.searching = true; state.search = ''; state.selected = 0; }
    else if (key === 'project') { const count = projectLimit(state.data); state.projectIndex = count ? (state.projectIndex + 1) % (count + 1) : 0; state.selected = 0; state.detail = false; onChange?.(state); }
    else if (key === 'reload') reloadData();
    return { state, action: key || 'noop' };
  };
  return { state, handleKey, render, setData, exit };
}

export async function runTui(stats, { input = process.stdin, output = process.stdout, reload = null, color = Boolean(output.isTTY) && !process.env.NO_COLOR, onExit = null } = {}) {
  if (!input?.isTTY || !output?.isTTY) throw new Error('--tui requires an interactive TTY; use --format json or --format markdown for redirected output');
  const oldRaw = typeof input.isRaw === 'boolean' ? input.isRaw : false;
  const oldEncoding = input.readableEncoding;
  let controller;
  const draw = () => {
    output.write(`${ESC}[2J${ESC}[H${renderFrame(controller.state, output.columns || 100, output.rows || 32, { color })}`);
  };
  controller = createTuiController(stats, { reload, onExit, onChange: () => { try { draw(); } catch { cleanup(); } } });
  let done;
  const promise = new Promise(resolve => { done = resolve; });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    input.off?.('data', onData);
    process.off?.('SIGWINCH', onResize);
    if (typeof input.setRawMode === 'function') input.setRawMode(oldRaw);
    if (oldEncoding) input.setEncoding?.(oldEncoding); else input.setEncoding?.(null);
    input.pause?.();
    output.write?.(`${ESC}[0m\n`);
    done(undefined);
  };
  const onResize = () => { try { draw(); } catch { cleanup(); } };
  const onData = chunk => {
    const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    // Escape sequences are parsed as complete key values where possible.
    for (let index = 0; index < value.length; index++) {
      let key = value[index];
      if (key === ESC && value[index + 1] === '[' && value[index + 2]) { key = value.slice(index, index + 3); index += 2; }
      const result = controller.handleKey(key);
      if (result.action === 'quit') { cleanup(); return; }
    }
    try { draw(); } catch { cleanup(); }
  };
  try {
    input.setRawMode?.(true); input.setEncoding?.('utf8'); input.resume?.(); input.on?.('data', onData); process.on?.('SIGWINCH', onResize); draw();
  } catch (error) { cleanup(); throw error; }
  return promise;
}

export const createTui = createTuiController;
