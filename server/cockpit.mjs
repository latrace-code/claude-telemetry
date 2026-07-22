// Cockpit de lecture des fiches. Rend une page autonome, sans dependance externe.
//
// Ne lit QUE les fiches (cards/). Les transcripts ne sont jamais servis en HTTP : ils contiennent
// le contenu des fichiers ouverts et la sortie des commandes, donc potentiellement des credentials.

// Palette categorielle validee (scripts/validate_palette.js, adjacent, light + dark) :
// light worst CVD 9.1 / normal-vision 19.6 · dark worst CVD 8.4 / normal-vision 19.3.
// L'ordre des slots est le mecanisme de securite CVD, pas un choix esthetique : ne pas le permuter.
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = n => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));

function hoursLabel(min) {
  const h = Math.floor((min || 0) / 60);
  const m = Math.round((min || 0) % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function aggregate(cards) {
  const byUser = new Map();
  const byDay = new Map();
  const totals = { sessions: 0, active: 0, prompts: 0, frictions: 0, tools: 0, errors: 0, tokens: 0, agents: 0 };

  for (const c of cards) {
    const u = c.user || 'inconnu';
    const d = c.date || '';
    const active = c.active_min || 0;
    const fr = (c.signals && c.signals.friction) || 0;

    if (!byUser.has(u)) byUser.set(u, { user: u, sessions: 0, active: 0, prompts: 0, frictions: 0, tools: 0, errors: 0, tokens: 0, agents: 0, projects: new Set(), surfaces: new Set(), scoped: false });
    const U = byUser.get(u);
    U.sessions++; U.active += active; U.prompts += c.user_prompts || 0; U.frictions += fr;
    U.tools += c.tools_total_all ?? c.tools_total ?? 0;
    U.errors += c.tool_errors_all ?? c.tool_errors ?? 0;
    U.tokens += c.tokens_out_all ?? c.tokens_out ?? 0;
    U.agents += c.agents_total || 0;
    if (c.project) U.projects.add(c.project);
    if (c.entrypoint) U.surfaces.add(c.entrypoint);
    if (c.scoped) U.scoped = true;

    if (!byDay.has(d)) byDay.set(d, { date: d, users: new Map(), total: 0 });
    const D = byDay.get(d);
    D.users.set(u, (D.users.get(u) || 0) + active);
    D.total += active;

    totals.sessions++; totals.active += active; totals.prompts += c.user_prompts || 0;
    totals.frictions += fr;
    totals.tools += c.tools_total_all ?? c.tools_total ?? 0;
    totals.errors += c.tool_errors_all ?? c.tool_errors ?? 0;
    totals.tokens += c.tokens_out_all ?? c.tokens_out ?? 0;
    totals.agents += c.agents_total || 0;
  }

  const users = [...byUser.values()].sort((a, b) => b.active - a.active);
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { users, days, totals };
}

function tile(label, value, sub) {
  return `<div class="tile"><div class="tile-l">${esc(label)}</div><div class="tile-v">${value}</div>${sub ? `<div class="tile-s">${esc(sub)}</div>` : ''}</div>`;
}

function stackedChart(days, users, colorOf) {
  if (!days.length) return '<p class="empty">Aucune session sur la periode.</p>';
  const max = Math.max(...days.map(d => d.total), 1);
  const order = users.map(u => u.user);
  const step = Math.ceil(days.length / 12);

  const cols = days.map((d, i) => {
    const segs = order.map(u => {
      const v = d.users.get(u) || 0;
      if (!v) return '';
      const h = (v / max) * 100;
      return `<div class="seg" style="height:${h.toFixed(2)}%;background:var(--s${colorOf.get(u) ?? 0})" data-tip="${esc(u)} · ${esc(hoursLabel(v))}"></div>`;
    }).join('');
    const label = i % step === 0 ? d.date.slice(8) + '/' + d.date.slice(5, 7) : '';
    return `<div class="col"><div class="stack" data-tip="${esc(d.date)} · ${esc(hoursLabel(d.total))}">${segs}</div><div class="xlab">${label}</div></div>`;
  }).join('');

  const legend = users.map(u => `<span class="lg"><i style="background:var(--s${colorOf.get(u.user) ?? 0})"></i>${esc(u.user)}</span>`).join('');
  return `<div class="legend">${legend}</div>
    <div class="chart" style="--max:${max}">
      <div class="ygrid"><span>${hoursLabel(max)}</span><span>${hoursLabel(max / 2)}</span><span>0</span></div>
      <div class="cols">${cols}</div>
    </div>`;
}

export function renderCockpit(allCards, { days: windowDays = 30, generatedAt = '', user: selected = '', bots = false } = {}) {
  // Les boucles automatiques (juge de friction, mineur nocturne, digest du soir) ne sont pas du
  // travail humain : elles n'ont ni relance ni friction, durent 0 minute, et sur un poste qui en
  // fait tourner beaucoup elles NOIENT les vraies sessions. Ecartees par defaut, jamais jetees :
  // leur cout est reel et reste affiche a part.
  const botCards = allCards.filter(c => c.automated);
  const humanCards = allCards.filter(c => !c.automated);
  const pool = bots ? allCards : humanCards;

  // Les couleurs sont assignees sur la population COMPLETE : filtrer sur une personne ne doit pas
  // repeindre les autres d'une vue a l'autre (la couleur suit l'entite, jamais son rang).
  const colorOf = new Map(aggregate(allCards).users.map((u, i) => [u.user, i % 5]));
  const everyone = [...colorOf.keys()];
  const cards = selected ? pool.filter(c => c.user === selected) : pool;
  const { users, days, totals } = aggregate(cards);
  const botTotals = aggregate(selected ? botCards.filter(c => c.user === selected) : botCards).totals;
  const errRate = totals.tools ? (totals.errors / totals.tools) * 100 : 0;

  const recent = [...cards].sort((a, b) => String(b.ts_start).localeCompare(String(a.ts_start))).slice(0, 60);
  const frictions = cards
    .flatMap(c => (c.friction_prompts || []).map(f => ({ ...f, user: c.user, date: c.date, project: c.project })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 25);

  const q = u => `?days=${windowDays}${u ? '&user=' + encodeURIComponent(u) : ''}`;
  const keepBots = bots ? '&bots=1' : '';
  const rangeLinks = [7, 30, 90].map(d =>
    `<a class="range${d === windowDays ? ' on' : ''}" href="?days=${d}${selected ? '&user=' + encodeURIComponent(selected) : ''}${keepBots}">${d} j</a>`).join('');
  const userLinks = everyone.length > 1
    ? `<div class="ranges"><a class="range${selected ? '' : ' on'}" href="${q('') + keepBots}">Tous</a>` +
      everyone.map(u => `<a class="range${selected === u ? ' on' : ''}" href="${q(u) + keepBots}"><i class="dot" style="background:var(--s${colorOf.get(u)})"></i>${esc(u)}</a>`).join('') + '</div>'
    : '';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telemetrie d'iteration IA</title>
<style>
  :root{color-scheme:light;--plane:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
    --grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--crit:#d03b3b;
    --s0:${SERIES_LIGHT[0]};--s1:${SERIES_LIGHT[1]};--s2:${SERIES_LIGHT[2]};--s3:${SERIES_LIGHT[3]};--s4:${SERIES_LIGHT[4]}}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;
    --ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
    --s0:${SERIES_DARK[0]};--s1:${SERIES_DARK[1]};--s2:${SERIES_DARK[2]};--s3:${SERIES_DARK[3]};--s4:${SERIES_DARK[4]}}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--plane);color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:28px 20px 64px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:22px;font-weight:700;margin:0}
  .sub{color:var(--ink2);font-size:13px;margin-top:4px}
  header{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;justify-content:space-between;margin-bottom:22px}
  .ranges{display:flex;gap:6px}
  .range{padding:5px 12px;border:1px solid var(--ring);border-radius:999px;text-decoration:none;color:var(--ink2);font-size:13px;background:var(--surface)}
  .range.on{background:var(--ink);color:var(--plane);border-color:var(--ink)}
  .range .dot{width:8px;height:8px;border-radius:3px;display:inline-block;margin-right:6px}
  .filters{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
  .ulink{color:inherit;text-decoration:none;border-bottom:1px solid var(--ring)}
  .ulink:hover{border-bottom-color:currentColor}
  section{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:20px;margin-bottom:18px}
  h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);margin:0 0 16px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
  .tile{padding:2px 0}
  .tile-l{font-size:12px;color:var(--muted)}
  .tile-v{font-size:30px;font-weight:700;line-height:1.15;margin-top:2px}
  .tile-s{font-size:12px;color:var(--ink2)}
  .legend{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px;font-size:13px;color:var(--ink2)}
  .lg{display:inline-flex;align-items:center;gap:6px}
  .lg i{width:10px;height:10px;border-radius:3px;display:inline-block}
  .chart{display:flex;gap:12px;height:240px}
  .ygrid{display:flex;flex-direction:column;justify-content:space-between;font-size:11px;color:var(--muted);
    text-align:right;padding-bottom:20px;min-width:52px;font-variant-numeric:tabular-nums}
  .cols{flex:1;display:flex;align-items:flex-end;gap:3px;border-bottom:1px solid var(--axis);padding-bottom:0}
  .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
  .stack{display:flex;flex-direction:column-reverse;justify-content:flex-start;gap:2px;height:100%;
    border-radius:4px 4px 0 0;overflow:hidden;position:relative}
  .seg{width:100%;min-height:2px}
  .stack:hover{outline:2px solid var(--ring);outline-offset:1px}
  .xlab{font-size:10px;color:var(--muted);text-align:center;height:20px;line-height:20px;white-space:nowrap;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;
    padding:0 10px 8px 0;border-bottom:1px solid var(--grid)}
  td{padding:9px 10px 9px 0;border-bottom:1px solid var(--grid);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .who{display:inline-flex;align-items:center;gap:7px;font-weight:600;white-space:nowrap}
  .who i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
  .subj{color:var(--ink2);max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{font-size:11px;color:var(--muted);white-space:nowrap}
  .alert{color:var(--crit);font-weight:600}
  .fr{border-left:2px solid var(--crit);padding:2px 0 2px 12px;margin-bottom:14px}
  .fr-m{font-size:11px;color:var(--muted);margin-bottom:2px}
  .empty{color:var(--muted);font-size:13px;margin:0}
  .note{color:var(--muted);font-size:12px;margin:16px 0 0;padding-top:14px;border-top:1px solid var(--grid)}
  .scoped{display:inline-block;margin-left:8px;font-size:10px;color:var(--muted);border:1px solid var(--ring);
    border-radius:999px;padding:1px 7px;vertical-align:1px;white-space:nowrap}
  .scroll{overflow-x:auto}
  #tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--ink);color:var(--plane);
    font-size:12px;padding:5px 9px;border-radius:6px;white-space:nowrap;z-index:9;transform:translate(-50%,-140%)}
  footer{color:var(--muted);font-size:12px;text-align:center;margin-top:26px}
</style></head>
<body><div class="wrap">
<header>
  <div><h1>Telemetrie d'iteration IA</h1>
    <div class="sub">${selected ? esc(selected) + ' · ' : 'Comment l\'equipe travaille avec Claude Code. '}${nf(totals.sessions)} sessions sur ${windowDays} jours.</div></div>
  <div class="filters">${userLinks}<div class="ranges">${rangeLinks}</div></div>
</header>

<section>
  <h2>Vue d'ensemble</h2>
  <div class="tiles">
    ${tile('Sessions', nf(totals.sessions), `${users.length} poste${users.length > 1 ? 's' : ''}`)}
    ${tile('Temps actif', hoursLabel(totals.active), 'hors attente et nuits')}
    ${tile('Relances humaines', nf(totals.prompts), totals.sessions ? `${(totals.prompts / totals.sessions).toFixed(1)} par session` : '')}
    ${tile('Frictions', nf(totals.frictions), 'prompts marques')}
    ${tile('Appels d\'outils', nf(totals.tools), `${errRate.toFixed(1)} % d'erreurs`)}
    ${tile('Tokens produits', nf(totals.tokens), `${nf(totals.agents)} agents`)}
  </div>
  ${botTotals.sessions ? `<p class="note">${nf(botTotals.sessions)} sessions automatiques (boucles d'amelioration, juge, digest) exclues de ces chiffres. Leur cout : ${nf(botTotals.tokens)} tokens, ${hoursLabel(botTotals.active)}. <a href="${q(selected)}${bots ? '' : '&bots=1'}" class="ulink">${bots ? 'les masquer' : 'les afficher'}</a>.</p>` : ''}
</section>

<section>
  <h2>Temps actif par jour</h2>
  ${stackedChart(days, users, colorOf)}
</section>

<section>
  <h2>Par poste</h2>
  <div class="scroll"><table>
    <tr><th>Poste</th><th class="num">Sessions</th><th class="num">Temps actif</th><th class="num">Relances</th>
      <th class="num">Frictions</th><th class="num">Outils</th><th class="num">Erreurs</th><th class="num">Tokens</th><th>Surface</th><th>Projets</th></tr>
    ${users.map(u => `<tr>
      <td><span class="who"><i style="background:var(--s${colorOf.get(u.user) ?? 0})"></i><a class="ulink" href="?days=${windowDays}&user=${encodeURIComponent(u.user)}">${esc(u.user)}</a></span>${u.scoped ? '<span class="scoped" title="Ce poste ne remonte qu\'une partie de ses sessions (perimetre restreint)">perimetre restreint</span>' : ''}</td>
      <td class="num">${nf(u.sessions)}</td>
      <td class="num">${hoursLabel(u.active)}</td>
      <td class="num">${nf(u.prompts)}</td>
      <td class="num${u.frictions ? ' alert' : ''}">${nf(u.frictions)}</td>
      <td class="num">${nf(u.tools)}</td>
      <td class="num">${u.tools ? ((u.errors / u.tools) * 100).toFixed(1) + ' %' : '—'}</td>
      <td class="num">${nf(u.tokens)}</td>
      <td class="tag">${esc([...u.surfaces].sort().join(', ') || '—')}</td>
      <td class="tag">${esc([...u.projects].slice(0, 3).join(', '))}</td></tr>`).join('')}
  </table></div>
</section>

<section>
  <h2>Frictions verbalisees</h2>
  ${frictions.length ? frictions.map(f => `<div class="fr">
      <div class="fr-m">${esc(f.date)} · ${esc(f.user || '')}${f.project ? ' · ' + esc(f.project) : ''}${f.famille ? ' · ' + esc(f.famille) : ''}</div>
      <div>${esc(f.text)}</div></div>`).join('')
    : '<p class="empty">Aucune friction verbalisee detectee sur la periode.</p>'}
</section>

<section>
  <h2>Dernieres sessions</h2>
  <div class="scroll"><table>
    <tr><th>Date</th><th>Poste</th><th>Projet</th><th>Sujet</th><th class="num">Actif</th>
      <th class="num">Relances</th><th class="num">Outils</th><th class="num">Frictions</th></tr>
    ${recent.map(c => {
      const fr = (c.signals && c.signals.friction) || 0;
      return `<tr>
        <td class="tag">${esc(c.date)}</td>
        <td><span class="who"><i style="background:var(--s${colorOf.get(c.user) ?? 0})"></i>${esc(c.user || '')}</span></td>
        <td class="tag">${esc(c.project || '')}</td>
        <td class="subj" title="${esc(c.subject)}">${esc(c.subject)}</td>
        <td class="num">${hoursLabel(c.active_min || 0)}</td>
        <td class="num">${nf(c.user_prompts)}</td>
        <td class="num">${nf(c.tools_total_all ?? c.tools_total)}</td>
        <td class="num${fr ? ' alert' : ''}">${fr || '—'}</td></tr>`;
    }).join('')}
  </table></div>
</section>

<footer>Genere ${esc(generatedAt)} · fiches uniquement, les transcripts ne sont pas servis ici</footer>
</div>
<div id="tip"></div>
<script>
  const tip = document.getElementById('tip');
  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    tip.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top = r.top + 'px';
    tip.style.opacity = 1;
  });
  document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) tip.style.opacity = 0; });
</script>
</body></html>`;
}
