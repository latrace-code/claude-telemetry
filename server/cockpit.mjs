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

// Minutes couvertes par l'UNION des fenetres [debut, fin] d'un poste. Sert de denominateur a la
// densite : deux sessions actives a la meme minute couvrent une seule minute d'horloge. Comparee au
// temps actif (qui, lui, LES compte toutes), elle revele le travail en parallele.
function unionMinutes(intervals) {
  const iv = intervals.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  if (!iv.length) return 0;
  let total = 0, cs = iv[0][0], ce = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const [s, e] = iv[i];
    if (s <= ce) ce = Math.max(ce, e); else { total += ce - cs; cs = s; ce = e; }
  }
  return (total + (ce - cs)) / 60000;
}

// Groupage des outils : combien de blocs tool_use l'IA place dans un MEME appel API. A ne pas
// confondre avec la densite ci-dessus, qui compte des SESSIONS en parallele. Ici on compte des
// outils dans un message. `batch_sessions` = fiches qui portent la mesure : les fiches emises avant
// l'ajout du champ ne l'ont pas, et un ratio calcule sur une partie du corpus doit se dire.
const ZERO_BATCH = { calls: 0, tools: 0, single: 0, sessions: 0 };
function addBatch(acc, card) {
  const tb = card.tool_batch_all || card.tool_batch;
  if (!tb || !tb.calls) return;
  acc.calls += tb.calls;
  acc.tools += tb.tools || 0;
  acc.single += tb.single_tool_calls || 0;
  acc.sessions++;
}
function perCall(b) { return b.calls ? b.tools / b.calls : 0; }
function perCallLabel(b) { return b.calls ? perCall(b).toFixed(2).replace('.', ',') : '—'; }
function monoPct(b) { return b.calls ? (100 * b.single) / b.calls : 0; }

// Ventilation du temps actif d'une fiche sur les jours qui l'ont produit. Rend [[jour, minutes]].
// Une session de plusieurs jours (les reprises Desktop courent jusqu'a 22 jours) voyait tout son
// actif impute a sa date de DEBUT : le travail etait donc date n'importe ou dans la fenetre. Les
// fiches en schema >= 6 portent `active_by_day` ; les anciennes n'ont que leur date de debut, on la
// garde en repli plutot que d'inventer une repartition.
function spreadActive(card, active) {
  const abd = card.active_by_day;
  if (abd && active > 0) {
    const days = Object.entries(abd).filter(([, v]) => v > 0);
    const sum = days.reduce((s, [, v]) => s + v, 0);
    // Les minutes par jour sont des arrondis : on les traite en POIDS pour que le total reste egal
    // a `active_min`, sinon la somme du graphe cesse de coller aux tuiles.
    if (sum > 0) return days.map(([day, v]) => [day, (active * v) / sum]);
  }
  return [[card.date || '', active]];
}

// Une fenetre de travail n'est connue QUE si la session est restee continue : sans dormant, et avec
// une duree d'horloge egale a actif + attente. Sinon on ignore ou le travail se place dans le span
// (les longues sessions Desktop s'etalent sur des jours), et l'approximation contigue depuis le
// debut fabriquait un denominateur faux : chez tom elle affichait 0,37x pour un parallelisme reel
// autour de 1,4x. Une densite se calcule donc sur ce sous-ensemble, ou pas du tout.
function workWindow(card, active, wait, dormant) {
  const startMs = card.ts_start ? Date.parse(card.ts_start) : null;
  const endMs = card.ts_end ? Date.parse(card.ts_end) : null;
  const work = active + wait;
  if (startMs === null || endMs === null || work <= 0 || dormant > 0) return null;
  const span = (endMs - startMs) / 60000;
  if (Math.abs(span - work) > Math.max(2, 0.05 * work)) return null;
  return [startMs, endMs];
}

// En dessous de cette part du temps actif couverte par des fenetres connues, la densite ne dit plus
// rien du poste : on n'affiche rien plutot qu'un chiffre calcule sur une minorite de son travail.
const DENSITY_MIN_COVERAGE = 0.6;

// --- Reprises de conversation ----------------------------------------------
// Question posee : combien de fois une meme conversation est-elle rouverte, combien de temps un fil
// reste-t-il vivant, et quelle part du travail passe par des reprises plutot que par des fils neufs.
//
// Le comptage se fait sur les fiches BRUTES, AVANT le repli, et c'est le point a ne pas confondre :
// une fiche repliee par foldChains n'est pas un doublon a jeter, c'est la trace d'une REOUVERTURE.
// Le repli sert au VOLUME de travail (ne pas compter deux fois les memes minutes), l'index ci-dessous
// sert au COMPORTEMENT (compter les fois ou on a rouvert). Les deux lisent le meme corpus et n'en
// tirent pas la meme chose ; brancher la mesure sur les fiches repliees rendrait 1,00 session par fil
// partout, c'est-a-dire exactement l'inverse de ce qu'on cherche a voir.
//
// Une fiche sans `chain_id` (emise avant que le champ existe) n'est rattachable a aucun fil : elle est
// hors de cette mesure, et la part du temps actif qu'elle represente est affichee comme telle.
function chainIndex(cards) {
  const idx = new Map();
  for (const c of cards) {
    if (!c.chain_id) continue;
    const e = idx.get(c.chain_id) || { n: 0, start: Infinity, end: -Infinity };
    e.n++;
    const s = Date.parse(c.ts_start);
    const f = Date.parse(c.ts_end);
    if (Number.isFinite(s)) e.start = Math.min(e.start, s);
    if (Number.isFinite(f)) e.end = Math.max(e.end, f);
    idx.set(c.chain_id, e);
  }
  return idx;
}

// Profondeur de reprise d'un fil. Trois paliers et pas une valeur continue : on cherche a lire un
// STYLE d'un coup d'oeil, pas a classer. Bornes calees sur le corpus (max observe : 6 sessions).
const DEPTH_LABELS = ['fil neuf, jamais repris', 'repris 1 a 2 fois', 'repris 3 fois ou plus'];
const depthBucket = n => (n >= 4 ? 2 : n >= 2 ? 1 : 0);

// Meme doctrine que la densite : en dessous de cette couverture, la repartition ne dit plus rien du
// poste et on affiche un tiret. Un zero calcule sur une minorite du travail ressemble a une mesure.
const REPRISE_MIN_COVERAGE = 0.6;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function chainCoverage(u) { return u.active ? u.chainActive / u.active : 0; }
function sessionsPerChain(u) { return u.chains ? u.chainSessions / u.chains : 0; }

// `cards` est deja replie : chaque fil n'y apporte donc ses minutes qu'une fois. Le NOMBRE de
// sessions du fil, lui, vient de l'index construit sur les fiches brutes.
function addChain(acc, card, chains) {
  const ch = card.chain_id ? chains.get(card.chain_id) : null;
  if (!ch) return;
  const active = Math.max(0, card.active_min || 0);
  acc.chainActive += active;
  acc.depth[depthBucket(ch.n)] += active;
  if (acc.chainSeen.has(card.chain_id)) return;
  acc.chainSeen.add(card.chain_id);
  acc.chainSessions += ch.n;
  if (ch.n > 1) {
    acc.reprised++;
    if (Number.isFinite(ch.start) && ch.end > ch.start) acc.spans.push((ch.end - ch.start) / 3600000);
  }
}

// Un champ absent veut dire "fiche emise avant la mesure", pas "aucune compaction". Les deux se
// distinguent par `compactSessions` : sans ce compteur, l'affichage rendrait un zero rassurant sur
// un corpus ou personne n'a jamais mesure.
function addCompactions(acc, card) {
  const k = card.compactions;
  if (!k || typeof k !== 'object') return;
  acc.compactSessions++;
  acc.compactions += k.total || 0;
  acc.compactAuto += k.auto || 0;
}

function aggregate(cards, chains = new Map()) {
  const byUser = new Map();
  const byDay = new Map();
  const newAcc = () => ({
    sessions: 0, active: 0, wait: 0, dormant: 0, wall: 0, prompts: 0, frictions: 0, tools: 0,
    errors: 0, tokens: 0, agents: 0, batch: { ...ZERO_BATCH }, covActive: 0,
    // Reprises : `chainActive` est le temps actif rattachable a un fil (le denominateur honnete des
    // parts), `depth` ventile ce temps par profondeur de reprise, `spans` porte la duree de vie des
    // seuls fils effectivement repris (celle d'un fil a une session n'est que sa propre duree).
    chainSeen: new Set(), chainSessions: 0, chains: 0, reprised: 0, chainActive: 0,
    depth: [0, 0, 0], spans: [],
    // Compactions : `compactSessions` compte les fiches qui PORTENT la mesure. Sans lui, un total a
    // zero ne se distingue pas d'un corpus emis avant l'ajout du champ.
    compactions: 0, compactAuto: 0, compactSessions: 0,
  });
  const totals = newAcc();
  const allIv = [];

  for (const c of cards) {
    const u = c.user || 'inconnu';
    // Clamp : de vieilles fiches portent un actif negatif (transcript non chronologique, -70h vu sur
    // un poste). La lib est corrigee, mais le bucket garde l'ancienne valeur jusqu'au recompute.
    const active = Math.max(0, c.active_min || 0);
    const wait = Math.max(0, c.wait_min || 0);
    const dormant = Math.max(0, c.dormant_min || 0);
    const wall = Math.max(0, c.wall_min || 0);
    const fr = (c.signals && c.signals.friction) || 0;
    const iv = workWindow(c, active, wait, dormant);

    if (!byUser.has(u)) byUser.set(u, { ...newAcc(), user: u, projects: new Set(), surfaces: new Set(), scoped: false, iv: [] });
    const U = byUser.get(u);
    addBatch(U.batch, c);
    addBatch(totals.batch, c);
    addChain(U, c, chains);
    addChain(totals, c, chains);
    addCompactions(U, c);
    addCompactions(totals, c);
    U.sessions++; U.active += active; U.wait += wait; U.dormant += dormant; U.wall += wall;
    U.prompts += c.user_prompts || 0; U.frictions += fr;
    U.tools += c.tools_total_all ?? c.tools_total ?? 0;
    U.errors += c.tool_errors_all ?? c.tool_errors ?? 0;
    U.tokens += c.tokens_out_all ?? c.tokens_out ?? 0;
    U.agents += c.agents_total || 0;
    if (c.project) U.projects.add(c.project);
    if (c.entrypoint) U.surfaces.add(c.entrypoint);
    if (c.scoped) U.scoped = true;
    if (iv) { U.iv.push(iv); allIv.push(iv); U.covActive += active; totals.covActive += active; }

    for (const [day, min] of spreadActive(c, active)) {
      if (!byDay.has(day)) byDay.set(day, { date: day, users: new Map(), total: 0 });
      const D = byDay.get(day);
      D.users.set(u, (D.users.get(u) || 0) + min);
      D.total += min;
    }

    totals.sessions++; totals.active += active; totals.wait += wait; totals.dormant += dormant; totals.wall += wall;
    totals.prompts += c.user_prompts || 0; totals.frictions += fr;
    totals.tools += c.tools_total_all ?? c.tools_total ?? 0;
    totals.errors += c.tool_errors_all ?? c.tool_errors ?? 0;
    totals.tokens += c.tokens_out_all ?? c.tokens_out ?? 0;
    totals.agents += c.agents_total || 0;
  }

  for (const U of byUser.values()) { U.covered = unionMinutes(U.iv); U.chains = U.chainSeen.size; delete U.iv; }
  totals.covered = unionMinutes(allIv);
  totals.chains = totals.chainSeen.size;
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

// Densite = temps actif / temps reel couvert (union des fenetres). >1 : plusieurs sessions actives
// en meme temps, c'est du travail parallele, pas un artefact. <1 : sessions etalees, longues pauses
// entre deux sollicitations (on code a la main, on reflechit). Caracterise un STYLE, sans le juger.
// Numerateur ET denominateur portent sur le MEME sous-ensemble : les sessions dont la fenetre de
// travail est connue (workWindow). Melanger l'actif total avec un denominateur partiel rendrait un
// ratio arbitraire, ce qui etait exactement le bug precedent.
function density(u) {
  if (!u.covered || !u.active) return 0;
  if (u.covActive / u.active < DENSITY_MIN_COVERAGE) return 0;
  return u.covActive / u.covered;
}
function densLabel(u) { const d = density(u); return d ? d.toFixed(2).replace('.', ',') + '×' : '—'; }
function densTitle(u) {
  const pct = u.active ? Math.round((100 * u.covActive) / u.active) : 0;
  return density(u)
    ? `sessions en parallele, calcule sur ${pct} % du temps actif (sessions continues)`
    : `non calculable : seules ${pct} % des minutes actives viennent de sessions dont la fenetre de travail est connue`;
}

// Ou part le temps de chaque poste : actif (on produit), attente/review (l'IA a rendu la main, on
// lit ou on est parti), dormant (session laissee ouverte > 90 min). Repond a "un petit temps actif
// veut-il dire peu de travail ?" : non, il faut voir la part d'attente a cote.
function timeBreakdown(users, colorOf) {
  if (!users.length) return '<p class="empty">Aucune session sur la periode.</p>';
  const maxTot = Math.max(...users.map(u => u.active + u.wait + u.dormant), 1);
  const rows = users.map(u => {
    const tot = u.active + u.wait + u.dormant;
    const w = x => (x / maxTot * 100).toFixed(2) + '%';
    const seg = (x, cls, name) => x ? `<span class="tb-seg ${cls}" style="width:${w(x)}" data-tip="${esc(name)} · ${esc(hoursLabel(x))}"></span>` : '';
    return `<div class="tb-row">
      <div class="tb-name"><span class="who"><i style="background:var(--s${colorOf.get(u.user) ?? 0})"></i>${esc(u.user)}</span></div>
      <div class="tb-track" style="width:${(tot / maxTot * 100).toFixed(2)}%">
        ${seg(u.active, 'act', 'actif')}${seg(u.wait, 'wai', 'attente / review')}${seg(u.dormant, 'dor', 'dormant')}</div>
      <div class="tb-dens" title="${esc(densTitle(u))}">${densLabel(u)}</div>
    </div>`;
  }).join('');
  return `<div class="tb-legend"><span class="lg"><i class="sw act"></i>actif</span><span class="lg"><i class="sw wai"></i>attente / review</span><span class="lg"><i class="sw dor"></i>dormant (session ouverte)</span><span class="lg tb-dhint">colonne de droite : densite (sessions en parallele)</span></div>
    <div class="tb">${rows}</div>`;
}

function spanLabel(h) {
  if (h == null) return '—';
  if (h >= 48) return `${Math.round(h / 24)} j`;
  if (h >= 1) return `${Math.round(h)} h`;
  return `${Math.round(h * 60)} min`;
}

// COMMENT CHAQUE POSTE TRAITE SES CONVERSATIONS, lu d'un coup d'oeil.
//
// Forme : une barre par poste, toutes ramenees a 100 %. On compare ici un STYLE, pas un volume (le
// volume est deja dans "Ou part le temps" juste au-dessus, et le laisser ici ecraserait les petits
// postes sans rien apprendre). Chaque barre repond a : sur tout le temps que ce poste a produit,
// quelle part est sortie d'un fil neuf, et quelle part est sortie d'une conversation deja ouverte.
//
// Palette : la rampe NEUTRE deja utilisee par "Ou part le temps", du clair au fonce, parce que la
// profondeur de reprise est une grandeur ordonnee (sequentiel = une teinte, clair -> fonce) et
// SURTOUT parce que les cinq teintes categorielles designent des personnes : une barre bleue a cote
// de la pastille bleue de lucas se lirait comme "lucas". En sombre la rampe s'inverse, la valeur
// forte restant celle qui contraste le plus avec le fond.
function repriseChart(users, colorOf) {
  if (!users.length) return '<p class="empty">Aucune session sur la periode.</p>';
  const rows = users.map(u => {
    const name = `<div class="rp-name"><span class="who"><i style="background:var(--s${colorOf.get(u.user) ?? 0})"></i>${esc(u.user)}</span></div>`;
    const cov = chainCoverage(u);
    if (!u.chains || !u.chainActive || cov < REPRISE_MIN_COVERAGE) {
      const why = !u.chains
        ? 'aucune fiche de ce poste ne porte l\'identifiant de fil (fiches emises avant la mesure)'
        : `seules ${Math.round(100 * cov)} % des minutes actives sont rattachables a un fil`;
      return `<div class="rp-row">${name}<div class="rp-track rp-void" title="${esc('Non mesurable : ' + why)}"></div><div class="rp-n">—</div><div class="rp-n">—</div></div>`;
    }
    const segs = u.depth.map((v, i) => {
      if (!v) return '';
      const pct = (100 * v) / u.chainActive;
      const label = pct >= 12 ? `${Math.round(pct)} %` : '';
      return `<span class="rp-seg r${i}" style="flex:0 0 ${pct.toFixed(2)}%" data-tip="${esc(`${DEPTH_LABELS[i]} · ${hoursLabel(v)} · ${Math.round(pct)} %`)}">${label}</span>`;
    }).join('');
    const spanTitle = u.reprised
      ? `mediane sur ${u.reprised} fil${u.reprised > 1 ? 's repris' : ' repris'} dans la fenetre affichee`
      : 'aucun fil repris sur la periode';
    return `<div class="rp-row">${name}
      <div class="rp-track"${cov < 0.98 ? ` title="${esc(`${Math.round(100 * cov)} % des minutes actives sont rattachables a un fil, le reste vient de fiches sans identifiant de fil`)}"` : ''}>${segs}</div>
      <div class="rp-n" title="nombre de sessions par conversation">${sessionsPerChain(u).toFixed(2).replace('.', ',')}</div>
      <div class="rp-n" title="${esc(spanTitle)}">${spanLabel(median(u.spans))}</div></div>`;
  }).join('');

  const legend = DEPTH_LABELS.map((l, i) => `<span class="lg"><i class="sw r${i}"></i>${esc(l)}</span>`).join('');
  return `<div class="rp-legend">${legend}</div>
    <div class="rp"><div class="rp-row rp-head"><div></div><div></div><div class="rp-n">sess./fil</div><div class="rp-n">vie du fil</div></div>${rows}</div>`;
}

// Reprendre une conversation cree une nouvelle session dont le transcript rejoue l'historique.
// Deux formes existent, et elles n'appellent pas le meme traitement :
//   - le rejeu garde le `sessionId` d'origine : le capteur l'a deja ecarte (`inherited_events` > 0),
//     les fiches du fil sont donc disjointes et doivent TOUTES etre comptees ;
//   - le rejeu est reetiquete au sid de la nouvelle session : le capteur ne peut rien voir, et les
//     fiches se recouvrent a 97-98 %. Mesure sur un poste reel : 4 fiches pour une seule
//     conversation. Dans ce cas on ne garde que la plus complete.
// `chain_id` (l'uuid du premier message) identifie le fil dans les deux cas.
//
// Le tri se fait FICHE PAR FICHE, jamais par groupe : un meme fil melange les deux formes. La regle
// precedente gardait tout le groupe des qu'UNE fiche portait `inherited_events`, et laissait donc
// passer les fiches reetiquetees qui, elles, se recopient. Mesure sur le fil a1d2e8db de tom
// (5 fiches, inherited [3577, 0, 824, 0, 0]) : 1 375 min comptees pour 1 093 min de travail reel.
// Corrige, le repli rend +0,4 % contre la verite terrain du poste au lieu de +3,0 %.
function foldChains(cards) {
  const byChain = new Map();
  const out = [];
  for (const c of cards) {
    if (!c.chain_id) { out.push(c); continue; }
    if (!byChain.has(c.chain_id)) byChain.set(c.chain_id, []);
    byChain.get(c.chain_id).push(c);
  }
  let folded = 0;
  for (const group of byChain.values()) {
    if (group.length === 1) { out.push(...group); continue; }
    const deduped = group.filter(c => (c.inherited_events || 0) > 0);
    const replayed = group.filter(c => !(c.inherited_events || 0));
    out.push(...deduped);
    if (replayed.length) {
      const weight = c => (c.tools_total || 0) + (c.user_prompts || 0);
      out.push(replayed.reduce((a, b) => (weight(b) > weight(a) ? b : a)));
      folded += replayed.length - 1;
    }
  }
  return { cards: out, folded };
}

// QUELLE VERSION DU CAPTEUR TOURNE SUR CHAQUE POSTE.
// Claude Code n'auto-update PAS un marketplace tiers : `autoUpdate` vaut false par defaut hors des
// marketplaces Anthropic, et un plugin installe reste epingle au commit du jour de l'installation.
// Un poste peut donc rester gele des semaines. Le symptome est muet : ses fiches continuent
// d'arriver, simplement sans les champs ajoutes depuis. C'est arrive du 22 au 27/07 sur les quatre
// postes, decouvert par hasard. On rend donc la panne visible sans avoir a la chercher.
// La reference n'est pas une constante a maintenir : c'est le commit du poste qui a emis la fiche la
// plus recente. Des qu'un seul poste passe a une nouvelle version, les autres sortent en retard.
// On compare des sha, donc par egalite : deux sha ne s'ordonnent pas, mais "different du plus
// recent" suffit a dire "n'a pas suivi". Ne PAS utiliser `schema` pour ca, recompute-from-bucket le
// reecrit avec la lib de la machine qui rejoue et masquerait justement le gel.
function capteurState(cards) {
  const latest = new Map();
  let ref = null;
  for (const c of cards) {
    const ts = String(c.ts_start || c.date || '');
    const u = c.user || 'inconnu';
    const prev = latest.get(u);
    if (!prev || ts > prev.ts) latest.set(u, { ts, version: c.plugin_version || null });
    if (c.plugin_version && (!ref || ts > ref.ts)) ref = { ts, version: c.plugin_version };
  }
  const byUser = new Map();
  const stale = [];
  for (const [u, v] of latest) {
    const isStale = !!ref && v.version !== ref.version;
    byUser.set(u, { version: v.version, stale: isStale });
    if (isStale) stale.push(u);
  }
  return { ref: ref ? ref.version : null, byUser, stale: stale.sort() };
}

function capteurCell(state, user) {
  const s = state.byUser.get(user);
  if (!s) return '<span class="dim">—</span>';
  if (!state.ref) return '<span class="dim">—</span>';
  if (!s.stale) return `<span class="dim" title="a jour">${esc(s.version || '—')}</span>`;
  const label = s.version || 'avant le suivi';
  return `<span class="stale" title="Ce poste tourne une version du capteur plus ancienne que ${esc(state.ref)} : ses fiches arrivent sans les mesures ajoutees depuis. Voir la procedure de resynchronisation dans le README.">${esc(label)} · en retard</span>`;
}

// Une boucle se reconnait a son flag, POSE PAR LA LIB AU MOMENT DE LA FICHE... donc absent de tout
// ce qui a ete calcule avant le correctif du 27/07. Le cockpit ne peut pas s'y fier seul : il lit un
// historique de plusieurs milliers de fiches ou 318 boucles de Lucas sur 14 jours portent encore
// `automated: false`. On re-teste donc la surface ici, ce qui rend l'affichage juste sans attendre
// un rejeu du corpus. A garder meme apres un rejeu : deux gardes valent mieux qu'une sur le chiffre
// qui sert de denominateur a tous les autres.
const isBot = c => c.automated || c.entrypoint === 'sdk-cli';

export function renderCockpit(rawCards, { days: windowDays = 30, generatedAt = '', user: selected = '', bots = false } = {}) {
  // Les boucles automatiques (juge de friction, mineur nocturne, digest du soir) ne sont pas du
  // travail humain : elles n'ont ni relance ni friction, durent 0 minute, et sur un poste qui en
  // fait tourner beaucoup elles NOIENT les vraies sessions. Ecartees par defaut, jamais jetees :
  // leur cout est reel et reste affiche a part.
  const { cards: allCards, folded } = foldChains(rawCards);
  const botCards = allCards.filter(isBot);
  const humanCards = allCards.filter(c => !isBot(c));
  const pool = bots ? allCards : humanCards;

  // Les couleurs sont assignees sur la population COMPLETE : filtrer sur une personne ne doit pas
  // repeindre les autres d'une vue a l'autre (la couleur suit l'entite, jamais son rang).
  // Etat des capteurs : calcule sur TOUT le corpus, boucles comprises. Une fiche de boucle vient de
  // la meme machine et dit donc la meme version, et le filtre par poste ne doit pas cacher qu'un
  // AUTRE poste est gele : la banniere parle de la flotte.
  const capteurs = capteurState(allCards);
  const colorOf = new Map(aggregate(allCards).users.map((u, i) => [u.user, i % 5]));
  const everyone = [...colorOf.keys()];
  const cards = selected ? pool.filter(c => c.user === selected) : pool;
  // Index des fils construit sur les fiches BRUTES du meme perimetre : c'est le nombre de fois qu'on
  // a rouvert une conversation, donc il se compte AVANT le repli. Le filtre par poste ne le change
  // pas (un fil appartient a une seule personne), celui des boucles si : leurs fils sont les leurs.
  const chains = chainIndex(bots ? rawCards : rawCards.filter(c => !isBot(c)));
  const { users, days, totals } = aggregate(cards, chains);
  const botTotals = aggregate(selected ? botCards.filter(c => c.user === selected) : botCards, chains).totals;
  const errRate = totals.tools ? (totals.errors / totals.tools) * 100 : 0;
  // Intensite = temps actif / temps reel couvert. Au-dela de 1, plusieurs sessions tournent en
  // parallele : c'est du travail sur plusieurs sujets a la fois, compte plein, pas un artefact.
  // Meme regle que la densite par poste : calculee sur les seules sessions dont la fenetre de
  // travail est connue, et pas affichee du tout si elles ne couvrent pas l'essentiel de l'actif.
  const intensity = density(totals);
  const intensityCov = totals.active ? Math.round((100 * totals.covActive) / totals.active) : 0;

  const recent = [...cards].sort((a, b) => String(b.ts_start).localeCompare(String(a.ts_start))).slice(0, 60);
  // Un poste qui ne partage pas son verbatim envoie ses frictions SANS texte : le compte et le cout
  // sont la, la phrase est restee sur la machine. On ne rend que celles qui portent un texte, et on
  // dit combien sont muettes plutot que d'afficher des blocs vides.
  const allFrictions = cards
    .flatMap(c => (c.friction_prompts || []).map(f => ({ ...f, user: c.user, date: c.date, project: c.project })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const quoted = allFrictions.filter(f => f.text);
  const frictions = quoted.slice(0, 25);
  const mutes = allFrictions.length - quoted.length;

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
    --act:#4b4a46;--wai:#a8a69e;--dor:#dcdbd3;
    --r0:#dcdbd3;--r1:#a8a69e;--r2:#4b4a46;--r0t:#0b0b0b;--r1t:#0b0b0b;--r2t:#f9f9f7;
    --s0:${SERIES_LIGHT[0]};--s1:${SERIES_LIGHT[1]};--s2:${SERIES_LIGHT[2]};--s3:${SERIES_LIGHT[3]};--s4:${SERIES_LIGHT[4]}}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;
    --ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
    --act:#e3e8eb;--wai:#6c6b67;--dor:#333330;
    --r0:#333330;--r1:#6c6b67;--r2:#e3e8eb;--r0t:#fff;--r1t:#fff;--r2t:#0d0d0d;
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
  .cap{color:var(--muted);font-size:12px;margin:14px 0 0}
  .tb{display:flex;flex-direction:column;gap:9px}
  .tb-row{display:grid;grid-template-columns:130px 1fr 54px;align-items:center;gap:12px}
  .tb-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tb-track{display:flex;height:16px;border-radius:4px;overflow:hidden;min-width:2px}
  .tb-seg{height:100%}.tb-seg.act{background:var(--act)}.tb-seg.wai{background:var(--wai)}.tb-seg.dor{background:var(--dor)}
  .tb-dens{font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink2)}
  .tb-legend{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:16px;font-size:13px;color:var(--ink2);align-items:center}
  .tb-legend .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
  .sw.act{background:var(--act)}.sw.wai{background:var(--wai)}.sw.dor{background:var(--dor)}
  .tb-dhint{color:var(--muted);font-size:12px;margin-left:auto}
  .rp{display:flex;flex-direction:column;gap:9px}
  .rp-row{display:grid;grid-template-columns:130px 1fr 68px 82px;align-items:center;gap:12px}
  .rp-head{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .rp-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rp-track{display:flex;height:20px;border-radius:4px;overflow:hidden;background:var(--grid)}
  .rp-void{border:1px dashed var(--axis);background:none;height:20px}
  .rp-seg{height:100%;display:flex;align-items:center;justify-content:center;font-size:11px;
    font-variant-numeric:tabular-nums;overflow:hidden;min-width:0}
  .rp-seg:not(:last-child){border-right:2px solid var(--surface)}
  .rp-seg.r0{background:var(--r0);color:var(--r0t)}
  .rp-seg.r1{background:var(--r1);color:var(--r1t)}
  .rp-seg.r2{background:var(--r2);color:var(--r2t)}
  .rp-n{font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink2)}
  .rp-legend{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:16px;font-size:13px;color:var(--ink2);align-items:center}
  .rp-legend .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
  .sw.r0{background:var(--r0)}.sw.r1{background:var(--r1)}.sw.r2{background:var(--r2)}
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
  .dim{color:var(--muted)}
  .stale{color:var(--crit);font-weight:600;cursor:help}
  .warn{border:1px solid var(--crit);border-left-width:3px;border-radius:6px;padding:12px 14px;margin-bottom:26px;
    font-size:13px;line-height:1.55;color:var(--ink2)}
  .warn b{color:var(--crit)}
  .warn code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
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

${capteurs.stale.length ? `<div class="warn"><b>Capteur en retard sur ${capteurs.stale.length} poste${capteurs.stale.length > 1 ? 's' : ''} : ${esc(capteurs.stale.join(', '))}.</b>
  Ces postes tournent une version anterieure a <code>${esc(capteurs.ref)}</code> : leurs fiches arrivent sans les mesures ajoutees depuis, et tout correctif pousse sur le depot ne les atteint pas.
  Claude Code ne met pas a jour un marketplace tiers tout seul. Resynchronisation : une commande a passer une fois sur le poste, decrite dans le README du depot.</div>` : ''}

<section>
  <h2>Vue d'ensemble</h2>
  <div class="tiles">
    ${tile('Sessions', nf(totals.sessions), `${users.length} poste${users.length > 1 ? 's' : ''}`)}
    ${tile('Temps actif', hoursLabel(totals.active), 'on produit, gaps > 5 min exclus')}
    ${tile('Temps machine', hoursLabel(totals.active + totals.wait), 'actif + attente / review')}
    ${tile('Intensite', intensity ? intensity.toFixed(2).replace('.', ',') + '×' : '—', intensity ? `sessions en parallele, sur ${intensityCov} % de l'actif` : 'non calculable sur cette fenetre')}
    ${tile('Conversations', totals.chains ? nf(totals.chains) : '—', totals.chains ? `${sessionsPerChain(totals).toFixed(2).replace('.', ',')} sessions par fil` : 'fils non identifies')}
    ${tile('Compactions', totals.compactSessions ? nf(totals.compactions) : '—', totals.compactSessions ? `${totals.compactions ? Math.round((100 * totals.compactAuto) / totals.compactions) + ' % subies' : 'aucun contexte sature'}` : 'pas encore mesure')}
    ${tile('Relances humaines', nf(totals.prompts), totals.sessions ? `${(totals.prompts / totals.sessions).toFixed(1)} par session` : '')}
    ${tile('Frictions', nf(totals.frictions), 'prompts marques')}
    ${tile('Appels d\'outils', nf(totals.tools), `${errRate.toFixed(1)} % d'erreurs`)}
    ${tile('Outils par appel', perCallLabel(totals.batch), totals.batch.calls ? `${monoPct(totals.batch).toFixed(0)} % n'en portent qu'un` : 'pas encore mesure')}
    ${tile('Tokens produits', nf(totals.tokens), `${nf(totals.agents)} agents`)}
  </div>
  <p class="note"><b>Temps actif</b> = le temps ou une machine que vous avez lancee produit vraiment (l'IA enchaine, vous ecrivez), les silences de plus de 5 min exclus. Il mesure l'<b>intensite de collaboration</b>, pas les heures de presence. Deux sessions actives a la meme minute comptent double : travailler sur plusieurs sujets en parallele compte plein. Un poste au temps actif faible n'a pas moins travaille : il sollicite l'IA par a-coups (voir la part d'attente ci-dessous).</p>
  <p class="note"><b>Outils par appel</b> = combien d'actions l'IA groupe dans un seul message, au lieu de les demander l'une apres l'autre. Lire trois fichiers d'un coup coute une attente ; les lire en trois messages en coute trois. Un aller-retour de plus prend environ 9,5 s, un outil de plus dans le meme message environ 0,8 s. Plus le chiffre monte, moins on attend pour le meme travail. Rien a voir avec la densite ci-dessous, qui compte des sessions en parallele.${totals.batch.sessions && totals.batch.sessions < totals.sessions ? ` Mesure sur ${nf(totals.batch.sessions)} des ${nf(totals.sessions)} sessions : les fiches emises avant l'ajout de la mesure ne la portent pas.` : ''}</p>
  ${folded ? `<p class="note">${nf(folded)} session(s) repliee(s) : ce sont des reprises d'une meme conversation, dont le transcript rejoue l'historique. Sans ce repli, le meme travail serait compte plusieurs fois. Les reouvertures restent comptees comme telles plus bas, dans "Reprises de conversation" : replier des minutes n'efface pas le geste.</p>` : ''}
  ${botTotals.sessions ? `<p class="note">${nf(botTotals.sessions)} sessions automatiques (agents headless, boucles d'amelioration, juge, digest) exclues de ces chiffres. Leur cout : ${nf(botTotals.tokens)} tokens, ${hoursLabel(botTotals.active)}. <a href="${q(selected)}${bots ? '' : '&bots=1'}" class="ulink">${bots ? 'les masquer' : 'les afficher'}</a>.</p>` : ''}
</section>

<section>
  <h2>Temps actif par jour</h2>
  ${stackedChart(days, users, colorOf)}
  <p class="cap">Empile le temps actif de chaque poste. Le parallelisme est compte plein : un jour peut donc depasser 24 h cumulees si plusieurs sessions tournent en meme temps.</p>
</section>

<section>
  <h2>Ou part le temps</h2>
  ${timeBreakdown(users, colorOf)}
  <p class="cap">Meme largeur = meme temps total (actif + attente + dormant). Un poste tres a droite en "attente" est present mais sollicite l'IA par a-coups ; il ne travaille pas moins. La densite (× a droite) dit combien de sessions tournent en parallele.</p>
</section>

<section>
  <h2>Reprises de conversation</h2>
  ${repriseChart(users, colorOf)}
  <p class="cap">Rouvrir une conversation plutot qu'en ouvrir une neuve est un style de travail, pas un defaut : on garde le contexte, mais il s'alourdit et finit par etre compacte. Chaque barre vaut 100 % du temps actif du poste, repartie selon le nombre de fois ou la conversation a ete rouverte. <b>Sess./fil</b> = sessions par conversation. <b>Vie du fil</b> = duree entre la premiere et la derniere session d'une conversation reprise, en mediane. Les fils qui debordent de la fenetre affichee y sont tronques : on ne voit que les reouvertures qui tombent dedans.</p>
</section>

<section>
  <h2>Par poste</h2>
  <div class="scroll"><table>
    <tr><th>Poste</th><th class="num">Sessions</th><th class="num" title="sessions par conversation : 1,00 = une conversation neuve a chaque fois">Sess./fil</th><th class="num">Temps actif</th><th class="num">Attente</th><th class="num" title="temps actif / temps reel : > 1 = sessions en parallele">Densite</th><th class="num">Relances</th>
      <th class="num">Frictions</th><th class="num">Outils</th><th class="num" title="outils groupes dans un meme appel API : plus c'est haut, moins on paie d'allers-retours">Outils/appel</th><th class="num">Erreurs</th><th class="num" title="fois ou le contexte a ete replie faute de place : signal de sante d'une session, pas de volume">Compactions</th><th class="num">Tokens</th><th>Surface</th><th title="commit du capteur installe sur le poste">Capteur</th><th>Projets</th></tr>
    ${users.map(u => `<tr>
      <td><span class="who"><i style="background:var(--s${colorOf.get(u.user) ?? 0})"></i><a class="ulink" href="?days=${windowDays}&user=${encodeURIComponent(u.user)}">${esc(u.user)}</a></span>${u.scoped ? '<span class="scoped" title="Ce poste ne remonte qu\'une partie de ses sessions (perimetre restreint)">perimetre restreint</span>' : ''}</td>
      <td class="num">${nf(u.sessions)}</td>
      <td class="num"${u.chains ? ` title="${esc(`${nf(u.chains)} conversation(s), dont ${nf(u.reprised)} reprise(s)`)}"` : ' title="aucune fiche de ce poste ne porte l\'identifiant de fil"'}>${u.chains ? sessionsPerChain(u).toFixed(2).replace('.', ',') : '—'}</td>
      <td class="num">${hoursLabel(u.active)}</td>
      <td class="num">${hoursLabel(u.wait)}</td>
      <td class="num" title="${esc(densTitle(u))}">${densLabel(u)}</td>
      <td class="num">${nf(u.prompts)}</td>
      <td class="num${u.frictions ? ' alert' : ''}">${nf(u.frictions)}</td>
      <td class="num">${nf(u.tools)}</td>
      <td class="num"${u.batch.calls ? ` title="${monoPct(u.batch).toFixed(0)} % des appels ne portent qu'un seul outil, sur ${nf(u.batch.sessions)} session(s) mesuree(s)"` : ''}>${perCallLabel(u.batch)}</td>
      <td class="num">${u.tools ? ((u.errors / u.tools) * 100).toFixed(1) + ' %' : '—'}</td>
      <td class="num"${u.compactSessions ? ` title="${esc(`dont ${nf(u.compactAuto)} subie(s) (contexte sature), mesure sur ${nf(u.compactSessions)} des ${nf(u.sessions)} sessions`)}"` : ' title="aucune fiche de ce poste ne porte encore la mesure"'}>${u.compactSessions ? nf(u.compactions) : '—'}</td>
      <td class="num">${nf(u.tokens)}</td>
      <td class="tag">${esc([...u.surfaces].sort().join(', ') || '—')}</td>
      <td class="tag">${capteurCell(capteurs, u.user)}</td>
      <td class="tag">${esc([...u.projects].slice(0, 3).join(', '))}</td></tr>`).join('')}
  </table></div>
</section>

<section>
  <h2>Frictions verbalisees</h2>
  ${frictions.length ? frictions.map(f => `<div class="fr">
      <div class="fr-m">${esc(f.date)} · ${esc(f.user || '')}${f.project ? ' · ' + esc(f.project) : ''}${f.famille ? ' · ' + esc(f.famille) : ''}</div>
      <div>${esc(f.text)}</div></div>`).join('')
    : '<p class="empty">Aucune friction verbalisee avec texte sur la periode.</p>'}
  ${mutes ? `<p class="note">${nf(mutes)} friction(s) comptee(s) sans texte : ces postes partagent le compte et le cout, pas la phrase. Elles restent dans les totaux ci-dessus.</p>` : ''}
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
        <td class="subj" title="${esc(c.subject || '')}">${c.subject ? esc(c.subject) : '<span class="tag">—</span>'}</td>
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
