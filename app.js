/* The public reader uses only the independently exported public data package. */
const app = document.querySelector('#app');
const cache = new Map();
const PAGE_SIZE = 40;
let manifest;
let nodes = [];
let sourceRows = [];
let nodeIndex = new Map();
let sourceIndex = new Map();
let adjacency;
let renderVersion = 0;
let queryTimer;
let composingSearch = false;
let currentRoute = { path: '/', params: new URLSearchParams() };

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const arr = value => Array.isArray(value) ? value : value ? [value] : [];
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();
const tokens = value => normalize(value).split(/\s+/u).filter(Boolean);
const number = value => Number(value || 0).toLocaleString('zh-CN');
const routeUrl = (path, params = {}) => {
  const query = params instanceof URLSearchParams ? params : new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null));
  return `#${path}${query.size ? `?${query}` : ''}`;
};
const publicUrl = value => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || /(^|\.)notion\.(?:so|com|site)$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
};
const label = value => typeof value === 'object' ? value.name || value.title || value.label || value.id : value;
const idValue = value => typeof value === 'object' ? value.id || label(value) : value;
const tags = (items, cls = '') => arr(items).map(item => `<span class="tag ${cls}"${cls === 'status-tag' ? ` data-status="${esc(item)}"` : ''}>${esc(item)}</span>`).join('');
const textBlock = value => String(value ?? '').split(/\n\s*\n/).filter(Boolean).map(part => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`).join('') || '<p class="muted">现有资料尚未补充这一项。</p>';
const nodeLink = (id, short = false) => {
  const node = nodeIndex.get(id);
  return `<a class="node-link" href="${routeUrl(`/node/${encodeURIComponent(id)}`)}"><span class="node-id">${esc(id)}</span>${short ? '' : ` ${esc(node?.name || '查看节点')}`}</a>`;
};
const sourceLink = id => `<a href="${routeUrl(`/source/${encodeURIComponent(id)}`)}">${esc(id)} · ${esc(sourceIndex.get(id)?.title || '查看来源')}</a>`;
const titleBlock = (title, subtitle, eyebrow = '研究数据库', actions = '') => `<header class="page-header"><div><p class="eyebrow">${esc(eyebrow)}</p><h1 class="page-title">${esc(title)}</h1>${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ''}</div>${actions ? `<div class="header-actions">${actions}</div>` : ''}</header>`;

async function getData(path) {
  if (!cache.has(path)) {
    const promise = fetch(`./data/${path}`, { cache: 'no-cache' }).then(async response => {
      if (!response.ok) throw new Error(`资料读取失败（${response.status}）`);
      return response.json();
    }).catch(error => { cache.delete(path); throw error; });
    cache.set(path, promise);
  }
  return cache.get(path);
}

function parseRoute() {
  const hash = location.hash.slice(1) || '/';
  const split = hash.indexOf('?');
  return { path: split < 0 ? hash : hash.slice(0, split), params: new URLSearchParams(split < 0 ? '' : hash.slice(split + 1)) };
}

function closeMenu() {
  document.body.classList.remove('menu-open');
  document.querySelector('#sidebar')?.classList.remove('open');
  document.querySelector('#menu-toggle')?.setAttribute('aria-expanded', 'false');
  document.querySelector('#menu-toggle')?.setAttribute('aria-label', '打开导航');
  const overlay = document.querySelector('#menu-overlay');
  if (overlay) { overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); }
}

function setQuery(key, value, { replace = false, keepFocus = false } = {}) {
  const params = new URLSearchParams(currentRoute.params);
  if (value) params.set(key, value); else params.delete(key);
  if (key !== 'page') params.delete('page');
  const next = routeUrl(currentRoute.path, params);
  const focused = keepFocus && document.activeElement?.id;
  const selection = focused && document.activeElement?.selectionStart;
  if (replace) {
    history.replaceState(null, '', next);
    render({ focusId: focused, selection, scroll: false });
  } else if (location.hash === next) {
    render({ focusId: focused, selection, scroll: false });
  } else {
    history.pushState(null, '', next);
    render({ focusId: focused, selection, scroll: key === 'page' });
  }
}

function rankNodes(rows, query) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return rows;
  const phrase = normalize(query);
  return rows.map(node => {
    const id = normalize(node.id);
    const name = normalize(node.name);
    const terms = normalize([node.english, ...arr(node.aliases)].join(' '));
    const core = normalize(node.core);
    const full = normalize([node.searchText, id, name, terms, core].join(' '));
    if (!queryTokens.every(token => full.includes(token))) return null;
    let score = id === phrase ? 10000 : 0;
    if (name === phrase || [node.english, ...arr(node.aliases)].some(term => normalize(term) === phrase)) score += 4000;
    if (name.includes(phrase)) score += 1600;
    if (terms.includes(phrase)) score += 1400;
    for (const token of queryTokens) {
      if (id.includes(token)) score += 600;
      if (name.includes(token)) score += 400;
      if (terms.includes(token)) score += 350;
      if (core.includes(token)) score += 150;
      if (full.includes(token)) score += 20;
    }
    return { node, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id, 'en', { numeric: true })).map(item => item.node);
}

function searchRows(rows, query, fields) {
  const queryTokens = tokens(query);
  return queryTokens.length ? rows.filter(row => {
    const full = normalize(fields.map(field => typeof field === 'function' ? field(row) : row[field]).join(' '));
    return queryTokens.every(token => full.includes(token));
  }) : rows;
}

function pageRows(rows, params, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const requested = Number(params.get('page'));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 1));
  return { rows: rows.slice((page - 1) * size, page * size), page, pages, total: rows.length, size };
}

function pagination(data) {
  if (data.pages <= 1) return '';
  const range = new Set([1, data.pages, data.page - 1, data.page, data.page + 1].filter(page => page > 0 && page <= data.pages));
  let previous = 0;
  const buttons = [...range].sort((a, b) => a - b).map(page => {
    const gap = previous && page > previous + 1 ? '<span class="pagination-gap" aria-hidden="true">…</span>' : '';
    previous = page;
    return `${gap}<button class="page-button ${page === data.page ? 'is-current' : ''}" data-page="${page}" ${page === data.page ? 'aria-current="page"' : ''} aria-label="第 ${page} 页">${page}</button>`;
  }).join('');
  return `<nav class="pagination" aria-label="结果分页"><button class="page-button" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''} aria-label="上一页">← 上一页</button>${buttons}<button class="page-button" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''} aria-label="下一页">下一页 →</button><span class="pagination-count">第 ${data.page} / ${data.pages} 页</span></nav>`;
}

function searchField(query, placeholder = '搜索中文、英文、别名或编号') {
  return `<label class="search-field" for="page-search"><span class="sr-only">搜索当前资料</span><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="1.7"/></svg><input id="page-search" type="search" autocomplete="off" value="${esc(query)}" placeholder="${esc(placeholder)}" data-query-key="q"></label>`;
}

function selectField(key, title, values, selected) {
  const options = arr(values).map(value => `<option value="${esc(idValue(value))}" ${String(idValue(value)) === selected ? 'selected' : ''}>${esc(label(value))}</option>`).join('');
  const hasSelected = arr(values).some(value => String(idValue(value)) === selected);
  return `<label class="filter-field" for="filter-${key}"><span>${esc(title)}</span><select id="filter-${key}" data-filter="${key}"><option value="">全部${esc(title)}</option>${selected && !hasSelected ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : ''}${options}</select></label>`;
}

function activeFilters(params, allowed = ['q', 'domain', 'source', 'status', 'level', 'phase', 'collection']) {
  const titles = { q: '检索', domain: '领域', source: '来源', status: '状态', level: '难度', phase: '阶段', collection: '体系', type: '关系类型' };
  const entries = [...params.entries()].filter(([key]) => allowed.includes(key));
  if (!entries.length) return '';
  return `<div class="active-filters" aria-label="当前筛选">${entries.map(([key, value]) => `<button class="filter-chip" data-remove-filter="${esc(key)}" aria-label="移除${esc(titles[key] || key)}筛选">${esc(titles[key] || key)}：${esc(sourceIndex.get(value)?.title || value)} <span aria-hidden="true">×</span></button>`).join('')}<button class="button-text" data-clear-filters>清空条件</button></div>`;
}

function emptyState(message = '没有找到符合条件的资料', detail = '可换一个关键词，或清空部分筛选条件。') {
  return `<div class="empty-state"><span class="empty-symbol" aria-hidden="true">⌕</span><h2>${esc(message)}</h2><p>${esc(detail)}</p><button class="button button-secondary" data-clear-filters>清空条件</button></div>`;
}

function nodeCard(node) {
  return `<article class="node-card"><div class="node-card-top"><span class="node-id">${esc(node.id)}</span><span class="meta-line">${esc(node.level || '')}</span></div><h2 class="node-title"><a href="${routeUrl(`/node/${node.id}`)}">${esc(node.name)}</a></h2>${node.english ? `<p class="node-english">${esc(node.english)}</p>` : ''}<p class="core-text">${esc(node.core)}</p><div class="tag-row">${tags(node.domains)}${tags(node.status, 'status-tag')}</div><div class="meta-line">${esc(arr(node.collections).join(' · '))}${arr(node.phases).length ? ` · ${esc(arr(node.phases).join(' / '))}` : ''}</div></article>`;
}

function platformPortals() {
  return `<section class="platform-portals" aria-labelledby="platform-portals-title"><h2 class="platform-portals-heading" id="platform-portals-title">三种阅读入口</h2><p class="platform-portals-lead">系统学习课程、查阅教练摘要，或沿着概念继续研究。</p><div class="platform-entry-grid"><a class="platform-entry" href="https://tsuk2mi.github.io/overwatch-competitive-studies/"><span class="platform-entry-number">01</span><h3>竞技学宝典</h3><p>原创竞技理论课程。从团队配合、团战逻辑、资源管理到站位与空间，提供系统化的竞技理论教学。</p><span class="platform-entry-action"><span>进入课程</span><span aria-hidden="true">↗</span></span></a><a class="platform-entry" href="https://tsuk2mi.github.io/ow-theory/"><span class="platform-entry-number">02</span><h3>Wizard 视频摘要</h3><p>整理 Wizard 教练的教学视频与战术理论，以结构化摘要的形式提供阅读和参考。</p><span class="platform-entry-action"><span>查阅摘要</span><span aria-hidden="true">↗</span></span></a><a class="platform-entry" href="#/nodes"><span class="platform-entry-number">03</span><h3>竞技学知识库</h3><p>整合原创理论、外部研究资料、战术概念和教学笔记，建立可以持续扩展的知识体系。</p><span class="platform-entry-action"><span>检索知识</span><span aria-hidden="true">→</span></span></a></div></section>`;
}

function homePage() {
  const counts = manifest.counts;
  const stats = [['nodes', '知识节点'], ['relations', '理论关系'], ['sources', '可追溯来源'], ['canonicalTerms', '主术语']];
  const updated = manifest.date || String(manifest.updatedAt || '').slice(0, 10);
  const domainCounts = new Map(arr(manifest.domains).map(domain => [String(idValue(domain)), 0]));
  nodes.forEach(node => arr(node.domains).forEach(domain => domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1)));
  const sourceCards = arr(manifest.collections).map(collection => ({ collection, count: nodes.filter(node => arr(node.collections).includes(collection)).length }));
  return `<section class="knowledge-hero" aria-labelledby="knowledge-home-title"><div class="knowledge-hero-main"><p class="eyebrow">OVERWATCH 2 / RESEARCH LIBRARY</p><h1 class="page-title" id="knowledge-home-title">把理论连成<br>可以使用的知识<span class="title-dot">.</span></h1><p class="hero-deck">从一个概念进入，沿着机制、条件、案例和出处继续追问。</p><div class="home-intro"><p>《守望先锋竞技学宝典》的研究数据库、理论底座与长期知识基础设施。</p><p class="meta-line">公开研究版 · 更新于 ${esc(updated)}</p></div><a class="text-link hero-read" href="#/nodes">开始检索 <span aria-hidden="true">↗</span></a></div><aside class="research-cover" aria-label="研究知识库阅读主线"><div class="research-cover-top"><span>COMPETITIVE<br>STUDIES</span><span>持续扩充<br>RESEARCH EDITION</span></div><div class="research-cover-title">从概念<span>到机制</span></div><div class="research-cover-index"><span>01 / 原创竞技学</span><span>02 / Wizard 理论</span><span>03 / 他山之玉</span><span>04 / 知识关联</span></div><div class="research-cover-bottom"><span>RESOURCE. WINDOW. ACTION.</span><a href="#/map" aria-label="打开理论地图">↗</a></div></aside></section><section class="stats-grid" aria-label="知识库规模">${stats.map(([key, title]) => `<div class="stat-card"><strong class="stat-value">${number(counts[key] ?? (key === 'canonicalTerms' ? counts.terms : 0))}</strong><span class="stat-label">${title}</span></div>`).join('')}</section>${platformPortals()}<section class="panel"><div class="panel-header"><div><p class="eyebrow">核心主线</p><h2 class="panel-title">一轮团战，如何连到下一轮</h2></div><a class="text-link" href="#/map">进入知识地图 ↗</a></div><div class="chain">${mainChainMarkup()}</div><p class="panel-note">主链提供阅读路径；具体关系与成立条件以各节点记录为准。大招、信息和团队沟通贯穿这条主线。</p></section><section class="panel"><div class="panel-header"><div><p class="eyebrow">四种阅读方式</p><h2 class="panel-title">从你的问题出发</h2></div></div><div class="browse-grid"><div class="browse-card"><span class="browse-number">01</span><h3>按理论领域</h3><p>资源、空间、节奏、站位、团战……</p><a href="#/nodes">浏览全部领域 →</a></div><div class="browse-card"><span class="browse-number">02</span><h3>按资料来源</h3><p>保留原创体系与外部教练的表达边界。</p><div class="browse-links">${sourceCards.map(item => `<a href="${routeUrl('/nodes', { collection: item.collection })}">${esc(item.collection)} <span>${number(item.count)}</span></a>`).join('')}</div></div><div class="browse-card"><span class="browse-number">03</span><h3>按教学难度</h3><p>选择适合当前学习阶段的概念。</p><div class="browse-links">${arr(manifest.levels).map(level => `<a href="${routeUrl('/nodes', { level: idValue(level) })}">${esc(label(level))}</a>`).join('')}</div></div><div class="browse-card"><span class="browse-number">04</span><h3>按游戏阶段</h3><p>从团战前准备到下一轮资源循环。</p><div class="browse-links">${arr(manifest.phases).map(phase => `<a href="${routeUrl('/nodes', { phase: idValue(phase) })}">${esc(label(phase))}</a>`).join('')}</div></div></div></section><section class="panel"><div class="panel-header"><div><p class="eyebrow">理论分类</p><h2 class="panel-title">知识领域</h2></div><a class="text-link" href="#/nodes">${number(counts.nodes)} 个节点 →</a></div><div class="domain-grid">${arr(manifest.domains).map((domain, index) => `<a class="domain-card" href="${routeUrl('/nodes', { domain: idValue(domain) })}"><span class="domain-number">${String(index + 1).padStart(2, '0')}</span><h3>${esc(String(label(domain)).replace(/^\d+\s*/, ""))}</h3><span>${number(domainCounts.get(String(idValue(domain))))} 个节点 <span aria-hidden="true">↗</span></span></a>`).join('')}</div></section><section class="panel editorial-note"><h2 class="panel-title">如何读这份研究库</h2><p>节点是知识的最小单位。同一主题可以保留不同教练的命题与适用条件，来源、证据范围和争议状态一起呈现。</p><p>【待验证】、【存在争议】与【待完善】都是研究状态。是否吸收外部观点、是否编入正式教材，由教练决定。</p><div class="header-actions"><a class="button button-secondary" href="#/docs/comparison">查看观点对照</a><a class="button button-secondary" href="#/docs/backlog">查看知识缺口</a></div></section>`;
}

function mainChainMarkup() {
  const shortLabels = ['胜利条件', '本波赢法', '阵容职能', '资源交换', '空间', '信息', '行动窗口', 'Timing', 'Staging', '站位', '枪线', 'Engage', '同步执行', '人数优势', '地图控制', '下一轮团战'];
  return arr(manifest.mainChain).map((step, index) => `${index ? '<span class="chain-arrow" aria-hidden="true">→</span>' : ''}<a class="chain-step" title="${esc(step.label)}" href="${step.id && nodeIndex.has(step.id) ? routeUrl(`/map`, { node: step.id }) : routeUrl('/nodes', { q: step.label })}"><span>${String(index + 1).padStart(2, '0')}</span>${esc(shortLabels[index] || step.label)}</a>`).join('');
}

function nodesPage(params) {
  const sourceOptions = sourceRows.map(source => ({ id: source.id, label: `${source.id} · ${String(source.title).slice(0, 70)}${String(source.title).length > 70 ? '…' : ''}` }));
  let filtered = nodes.filter(node => {
    if (params.get('domain') && !arr(node.domains).includes(params.get('domain'))) return false;
    if (params.get('status') && !arr(node.status).includes(params.get('status'))) return false;
    if (params.get('level') && node.level !== params.get('level')) return false;
    if (params.get('phase') && !arr(node.phases).includes(params.get('phase'))) return false;
    if (params.get('collection') && !arr(node.collections).includes(params.get('collection'))) return false;
    const source = params.get('source');
    if (source && !arr(node.sourceIds).some(id => id === source || sourceIndex.get(id)?.voice === source)) return false;
    return true;
  });
  filtered = rankNodes(filtered, params.get('q'));
  const page = pageRows(filtered, params);
  return `${titleBlock('知识节点', '检索命题、机制与适用条件，再沿关系和出处继续阅读。')}<section class="toolbar" aria-label="知识检索与筛选">${searchField(params.get('q'))}<div class="filter-grid">${selectField('domain', '领域', manifest.domains, params.get('domain'))}${selectField('collection', '体系', manifest.collections, params.get('collection'))}${selectField('source', '来源', sourceOptions, params.get('source'))}${selectField('status', '状态', manifest.statuses, params.get('status'))}${selectField('level', '难度', manifest.levels, params.get('level'))}${selectField('phase', '阶段', manifest.phases, params.get('phase'))}</div>${activeFilters(params)}</section><div class="results-meta" role="status" aria-live="polite"><span>找到 <strong>${number(page.total)}</strong> 个节点</span><span>每页 ${PAGE_SIZE} 条 · 多领域节点可同时归类</span></div>${page.total ? `<div class="node-list">${page.rows.map(nodeCard).join('')}</div>${pagination(page)}` : emptyState()}`;
}

async function relationsData() {
  const relations = await getData('relations.json');
  if (!adjacency) {
    adjacency = new Map();
    relations.forEach(relation => {
      for (const id of new Set([relation.from, relation.to])) {
        if (!adjacency.has(id)) adjacency.set(id, []);
        adjacency.get(id).push(relation);
      }
    });
  }
  return relations;
}

function linkGroup(title, ids) {
  const unique = [...new Set(arr(ids))].filter(id => nodeIndex.has(id));
  return unique.length ? `<section class="detail-section"><h2 class="section-title">${esc(title)}</h2><ul class="concept-links">${unique.map(id => `<li>${nodeLink(id)}</li>`).join('')}</ul></section>` : '';
}

function relationList(relations, focusId = null, expanded = false) {
  if (!relations.length) return '<p class="muted">这一节点尚未记录明确关系。</p>';
  const grouped = new Map();
  relations.forEach(relation => {
    if (!grouped.has(relation.type)) grouped.set(relation.type, []);
    grouped.get(relation.type).push(relation);
  });
  return [...grouped.entries()].map(([type, rows]) => `<div class="relation-group"><h3>${esc(type)} <span class="meta-line">${rows.length}</span></h3>${rows.map(relation => `<article class="relation-item"><p class="relation-direction">${nodeLink(relation.from)} <span class="relation-arrow" aria-label="${esc(type)}">→</span> ${nodeLink(relation.to)}</p>${relation.explanation ? `<p>${esc(relation.explanation)}</p>` : ''}${arr(relation.references).length ? `<p class="meta-line">依据：${arr(relation.references).map(ref => typeof ref === 'object' ? `${sourceLink(ref.sourceId)}${ref.location ? `（${esc(ref.location)}）` : ''}` : esc(ref)).join(' · ')}</p>` : ''}</article>`).join('')}</div>`).join('');
}

function referenceItem(ref) {
  const source = sourceIndex.get(ref.sourceId);
  return `<li class="source-item"><div>${sourceLink(ref.sourceId)}</div>${source ? `<p class="meta-line">${esc(source.voice)} · ${esc(source.state)}</p>` : ''}${ref.location ? `<p>${esc(ref.location)}</p>` : ''}${source?.evidence ? `<p class="source-evidence">证据范围：${esc(source.evidence)}</p>` : ''}${publicUrl(source?.url) ? `<a class="external-link" href="${esc(publicUrl(source.url))}" target="_blank" rel="noopener noreferrer">打开公开原始链接 ↗</a>` : '<span class="meta-line">公开版保留来源定位；原始载体未公开。</span>'}</li>`;
}

async function nodePage(id) {
  if (!nodeIndex.has(id)) return `${titleBlock('节点不存在', '请检查编号，或从知识节点列表重新查找。')}<a class="button" href="#/nodes">浏览知识节点</a>`;
  const [node] = await Promise.all([getData(`nodes/${id}.json`), relationsData()]);
  const relations = adjacency.get(id) || [];
  const references = arr(node.references);
  return `${titleBlock(node.name, node.english || '', `${node.id} · 知识节点`, `<button class="button button-secondary" data-copy-node="${esc(id)}">复制节点链接</button><a class="button button-secondary" href="${routeUrl('/map', { node: id })}">查看关系图</a>`)}<div class="tag-row detail-tags">${tags(node.domains)}${tags(node.status, 'status-tag')}${tags(node.collections)}</div>${arr(node.aliases).length ? `<p class="meta-line aliases">别名：${esc(arr(node.aliases).join(' · '))}</p>` : ''}<div class="detail-layout"><div class="detail-main"><section class="detail-section core-section"><h2 class="section-title">核心命题</h2><div class="reading-text">${textBlock(node.core)}</div></section>${[['mechanism', '原理与机制'], ['examples', '实战表现'], ['application', '应用条件'], ['mistakes', '常见错误']].map(([key, title]) => `<section class="detail-section"><h2 class="section-title">${title}</h2><div class="reading-text">${textBlock(node[key])}</div></section>`).join('')}<section class="detail-section"><h2 class="section-title">来源与读取范围</h2><p class="muted">每项引用保留自己的出处和证据范围。正文中的外部命题按原有研究状态呈现。</p>${references.length ? `<ul class="source-list">${references.slice(0, 5).map(referenceItem).join('')}</ul>${references.length > 5 ? `<details class="more-sources"><summary>展开其余 ${references.length - 5} 项来源</summary><ul class="source-list">${references.slice(5).map(referenceItem).join('')}</ul></details>` : ''}` : '<p class="muted">当前节点尚未形成独立定位记录。</p>'}</section><section class="detail-section"><div class="panel-header"><h2 class="section-title">理论关系</h2><a href="${routeUrl('/map', { node: id })}">在知识地图中浏览 →</a></div>${relationList(relations, id)}</section></div><aside class="detail-aside"><section class="detail-section"><h2 class="section-title">阅读信息</h2><dl class="metadata-list"><dt>教学难度</dt><dd>${esc(node.level || '未标注')}</dd><dt>游戏阶段</dt><dd>${esc(arr(node.phases).join(' / ') || '未标注')}</dd><dt>命题性质</dt><dd>${esc(node.nature || '以来源记录为准')}</dd><dt>理论状态</dt><dd>${tags(node.status, 'status-tag')}</dd></dl></section>${linkGroup('上位概念', node.parent)}${linkGroup('下位概念', node.children)}${linkGroup('相关概念', node.related)}</aside></div><p class="copy-status sr-only" id="copy-status" role="status" aria-live="polite"></p>`;
}

async function glossaryPage(params) {
  const terms = await getData('glossary.json');
  const termIndex = new Map(terms.map(term => [term.id, term]));
  const filtered = searchRows(terms, params.get('q'), ['id', 'zh', 'en', 'definition', 'misuse', 'sourceText']);
  const page = pageRows(filtered, params);
  return `${titleBlock('OW2 战术术语库', '中文与英文定义、常见误译及相关理论。别名指向主术语。')}<section class="toolbar">${searchField(params.get('q'), '搜索 Space、Timing、空间或术语编号')}${activeFilters(params, ['q'])}</section><div class="results-meta" role="status"><span>找到 <strong>${number(page.total)}</strong> 条术语记录</span><span>${number(manifest.counts.canonicalTerms || terms.filter(term => !term.canonicalId).length)} 条主术语</span></div>${page.total ? `<div class="term-list">${page.rows.map(term => `<article class="term-card" id="term-${esc(term.id)}"><div class="node-card-top"><span class="node-id">${esc(term.id)}</span>${term.canonicalId ? '<span class="tag">兼容别名</span>' : ''}</div><h2 class="node-title">${esc(term.zh)} <span class="node-english">${esc(term.en)}</span></h2>${term.canonicalId ? `<p class="canonical-notice">主术语：<a href="${routeUrl('/glossary', { q: term.canonicalId })}">${esc(term.canonicalId)} · ${esc(termIndex.get(term.canonicalId)?.zh || '查看主术语')}</a></p>` : ''}<div class="reading-text">${textBlock(term.definition)}</div>${term.misuse ? `<p class="term-misuse"><strong>常见误译与误解：</strong>${esc(term.misuse)}</p>` : ''}${arr(term.nodeIds).length ? `<div class="concept-inline"><span>相关节点</span>${arr(term.nodeIds).filter(id => nodeIndex.has(id)).map(id => nodeLink(id)).join('')}</div>` : ''}${term.sourceText ? `<p class="meta-line">来源：${esc(term.sourceText)}</p>` : ''}</article>`).join('')}</div>${pagination(page)}` : emptyState()}`;
}

function sourceCard(source) {
  return `<article class="source-card"><div class="node-card-top"><span class="node-id">${esc(source.id)}</span><span class="tag">${esc(source.voice)}</span></div><h2 class="node-title"><a href="${routeUrl(`/source/${source.id}`)}">${esc(source.title)}</a></h2><p class="core-text">${esc(source.evidence)}</p><div class="meta-line">读取状态：${esc(source.state)}</div>${source.canonicalId ? `<p class="meta-line">同一载体规范来源：${sourceLink(source.canonicalId)}</p>` : ''}</article>`;
}

function sourcesPage(params) {
  const sourceOptions = sourceRows.map(source => ({ id: source.id, label: `${source.id} · ${String(source.title).slice(0, 70)}${String(source.title).length > 70 ? '…' : ''}` }));
  let filtered = sourceRows.filter(source => (!params.get('source') || source.id === params.get('source') || source.voice === params.get('source')) && (!params.get('collection') || source.collection === params.get('collection')));
  filtered = searchRows(filtered, params.get('q'), ['id', 'title', 'voice', 'evidence', 'state']);
  const page = pageRows(filtered, params);
  return `${titleBlock('来源索引', '从出处进入知识网络，并核对资料的读取范围。')}<section class="toolbar">${searchField(params.get('q'), '搜索作者、视频、文章或来源编号')}<div class="filter-grid compact-filters">${selectField('source', '来源', sourceOptions, params.get('source'))}${selectField('collection', '体系', manifest.collections, params.get('collection'))}</div>${activeFilters(params, ['q', 'source', 'collection'])}</section><div class="results-meta" role="status"><span>找到 <strong>${number(page.total)}</strong> 项来源</span><span>来源索引记录已读原文、摘要、字幕及待核实载体</span></div>${page.total ? `<div class="node-list">${page.rows.map(sourceCard).join('')}</div>${pagination(page)}` : emptyState()}`;
}

function sourcePage(id, params) {
  const source = sourceIndex.get(id);
  if (!source) return `${titleBlock('来源不存在', '请检查来源编号。')}<a class="button" href="#/sources">来源索引</a>`;
  const related = nodes.filter(node => arr(node.sourceIds).includes(id));
  const page = pageRows(related, params);
  const external = publicUrl(source.url);
  return `${titleBlock(source.title, source.voice || '', `${id} · 来源记录`, external ? `<a class="button button-secondary" href="${esc(external)}" target="_blank" rel="noopener noreferrer">打开公开原始链接 ↗</a>` : '')}<section class="panel source-record"><dl class="metadata-list"><dt>来源归属</dt><dd>${esc(source.voice || source.collection || '未标注')}</dd><dt>读取状态</dt><dd>${esc(source.state)}</dd><dt>证据与范围</dt><dd>${esc(source.evidence)}</dd>${source.canonicalId ? `<dt>规范来源</dt><dd>${sourceLink(source.canonicalId)}</dd>` : ''}</dl>${!external ? '<p class="panel-note">此载体的原始链接未公开。公开版保留来源标题、归属、读取状态及关联节点。</p>' : ''}</section><div class="results-meta"><h2 class="section-title">关联知识节点</h2><span>${number(page.total)} 个节点</span></div>${page.total ? `<div class="node-list">${page.rows.map(nodeCard).join('')}</div>${pagination(page)}` : '<div class="empty-state"><h2>尚未形成关联节点</h2><p>来源已登记，原文读取或知识原子化仍可能在进行中。</p></div>'}`;
}

function mapGraph(focusId, relations, all) {
  const grouped = new Map();
  relations.forEach(relation => {
    const other = relation.from === focusId ? relation.to : relation.from;
    if (other === focusId || !nodeIndex.has(other)) return;
    if (!grouped.has(other)) grouped.set(other, []);
    grouped.get(other).push(relation);
  });
  const entries = [...grouped.entries()];
  const selected = all ? entries : entries.slice(0, 24);
  if (!selected.length) return { svg: '<div class="empty-state"><h3>暂无匹配的相邻关系</h3><p>可调整关系类型，或选择另一个节点。</p></div>', shown: 0, total: entries.length };
  const left = selected.filter(([, rows]) => rows[0].to === focusId);
  const right = selected.filter(([, rows]) => rows[0].to !== focusId);
  const height = Math.max(380, Math.max(left.length, right.length) * 84 + 70);
  const width = 1050;
  const center = { x: 525, y: height / 2 };
  const points = new Map([[focusId, center]]);
  for (const [side, list] of [[150, left], [900, right]]) list.forEach(([id], index) => points.set(id, { x: side, y: height / 2 - (list.length - 1) * 42 + index * 84 }));
  const edges = selected.flatMap(([, rows]) => rows).map((relation, index) => {
    const from = points.get(relation.from), to = points.get(relation.to);
    if (!from || !to) return '';
    const sign = to.x > from.x ? 1 : -1;
    const x1 = from.x + sign * 82, x2 = to.x - sign * 90;
    const mid = (x1 + x2) / 2;
    const lift = index % 3 * 9 - 9;
    const y = (from.y + to.y) / 2 + lift;
    return `<g class="map-edge"><path d="M ${x1} ${from.y} C ${mid} ${from.y + lift}, ${mid} ${to.y + lift}, ${x2} ${to.y}" fill="none" stroke="currentColor" stroke-width="1.3" marker-end="url(#relation-arrow)"/><rect x="${mid - 56}" y="${y - 9}" width="112" height="18" rx="4"/><text x="${mid}" y="${y + 4}" text-anchor="middle">${esc(relation.type)}</text><title>${esc(`${relation.from} ${relation.type} ${relation.to}：${relation.explanation || ''}`)}</title></g>`;
  }).join('');
  const graphNodes = [...points.entries()].map(([id, point]) => {
    const node = nodeIndex.get(id);
    const name = String(node.name).length > 14 ? `${String(node.name).slice(0, 13)}…` : node.name;
    return `<a class="map-node ${id === focusId ? 'is-focus' : ''}" href="${routeUrl('/map', { node: id })}" aria-label="聚焦 ${esc(node.name)}"><rect x="${point.x - 82}" y="${point.y - 29}" width="164" height="58" rx="9"/><text class="map-node-id" x="${point.x}" y="${point.y - 8}" text-anchor="middle">${esc(id)}</text><text x="${point.x}" y="${point.y + 13}" text-anchor="middle">${esc(name)}</text><title>${esc(node.name)}</title></a>`;
  }).join('');
  return { svg: `<svg class="map-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(nodeIndex.get(focusId)?.name)}的相邻知识关系"><defs><marker id="relation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor"/></marker></defs>${edges}${graphNodes}</svg>`, shown: selected.length, total: entries.length };
}

async function mapPage(params) {
  await relationsData();
  const defaultId = arr(manifest.mainChain).find(step => nodeIndex.has(step.id))?.id || nodes[0]?.id;
  const requestedId = params.get('node') || defaultId;
  const focusId = nodeIndex.has(requestedId) ? requestedId : defaultId;
  const node = nodeIndex.get(focusId);
  const related = adjacency.get(focusId) || [];
  const types = [...new Set(related.map(relation => relation.type))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const filtered = params.get('type') ? related.filter(relation => relation.type === params.get('type')) : related;
  const all = params.get('all') === '1';
  const graph = mapGraph(focusId, filtered, all);
  return `${titleBlock('竞技学知识地图', '从主链进入主题；箭头表示记录中的方向，关系列表保留条件与解释。')}<section class="panel"><div class="chain">${mainChainMarkup()}</div></section><section class="map-controls toolbar"><form id="map-focus-form" class="map-focus-form"><label for="map-focus">选择主题（编号或关键词）</label><div class="inline-form"><input id="map-focus" name="node" value="${esc(focusId)}" placeholder="例如 N023 或 资源窗口" autocomplete="off"><button class="button" type="submit">聚焦主题</button></div></form>${selectField('type', '关系类型', types, params.get('type'))}</section>${requestedId !== focusId ? `<p class="panel-note" role="status">未找到 ${esc(requestedId)}，已展示主链起点。</p>` : ''}<section class="panel"><div class="panel-header"><div><p class="eyebrow">${esc(focusId)} · 当前主题</p><h2 class="panel-title">${esc(node.name)}</h2></div><a class="button button-secondary" href="${routeUrl(`/node/${focusId}`)}">阅读完整节点</a></div><p class="core-text">${esc(node.core)}</p><div class="tag-row">${tags(node.status, 'status-tag')}</div><div class="map-canvas">${graph.svg}</div><div class="map-caption"><span>展示 ${graph.shown} / ${graph.total} 个相邻节点 · ${number(filtered.length)} 条关系</span>${graph.total > 24 ? `<button class="button button-secondary button-small" data-map-all="${all ? '0' : '1'}">${all ? '收起至 24 个节点' : '展开全部相邻节点'}</button>` : ''}</div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">可阅读的关系列表</h2><span class="meta-line">方向与上图一致</span></div>${relationList(filtered, focusId)}</section>`;
}

function safeDocumentHtml(html) {
  const document = new DOMParser().parseFromString(String(html || ''), 'text/html');
  document.querySelectorAll('script,iframe,object,embed,style,form,meta,link,base').forEach(element => element.remove());
  document.querySelectorAll('*').forEach(element => [...element.attributes].forEach(attribute => {
    if (attribute.name.startsWith('on') || ['style', 'srcdoc'].includes(attribute.name)) element.removeAttribute(attribute.name);
    if (['href', 'src'].includes(attribute.name)) {
      const value = attribute.value;
      if (value.startsWith('#/')) return;
      const url = publicUrl(value);
      if (!url || attribute.name === 'src') element.removeAttribute(attribute.name);
      else { element.setAttribute('href', url); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); }
    }
  }));
  return document.body.innerHTML;
}

async function docsPage(slug, params) {
  if (!arr(manifest.documents).some(document => document.slug === slug)) return `${titleBlock('文档不存在', '可从侧栏选择观点对照、知识缺口或课程候选。')}<a class="button" href="#/">返回首页</a>`;
  const document = await getData(`docs/${slug}.json`);
  const docRows = arr(document.sections);
  const filtered = searchRows(docRows, params.get('q'), ['title', row => row.nodeIds?.join(' '), row => new DOMParser().parseFromString(row.html || '', 'text/html').body.textContent]);
  let pageParams = new URLSearchParams(params);
  const requestedSection = params.get('section');
  const requestedIndex = filtered.findIndex(section => section.id === requestedSection);
  if (requestedSection && requestedIndex >= 0 && !params.has('page')) pageParams.set('page', String(Math.floor(requestedIndex / 20) + 1));
  const page = pageRows(filtered, pageParams, 20);
  const subtitles = { comparison: '并列保留不同来源的命题、共同点、差异与吸收判断。', backlog: '研究中尚未解释、尚未验证或缺少案例的问题。', courses: '已经积累理论与教学素材的候选主题，成熟度以原记录为准。' };
  return `${titleBlock(document.title, subtitles[slug] || '按主题检索并展开原有研究文档。')}<section class="toolbar">${searchField(params.get('q'), '搜索主题、节点编号或文档内容')}${activeFilters(params, ['q'])}</section><div class="results-meta" role="status"><span>找到 <strong>${number(page.total)}</strong> 个文档段落</span><span>每页 20 段 · 展开后阅读正文</span></div>${page.total ? `<nav class="document-toc" aria-label="本页段落目录">${page.rows.map(section => `<a href="#section-${esc(section.id)}" data-open-section="${esc(section.id)}">${esc(section.title || '研究记录')}</a>`).join('')}</nav><div class="document-sections">${page.rows.map(section => `<details class="document-section" id="section-${esc(section.id)}" data-doc-section="${esc(section.id)}" ${section.id === requestedSection ? 'open' : ''}><summary><span>${esc(section.title || '研究记录')}</span><span class="section-expand" aria-hidden="true">＋</span></summary><div class="document-html" data-doc-body="${esc(section.id)}">${section.id === requestedSection ? safeDocumentHtml(section.html) : ''}</div></details>`).join('')}</div>${pagination(page)}` : emptyState()}`;
}

function updateShell(path) {
  let section = path.startsWith('/node') ? 'nodes' : path.startsWith('/source') ? 'sources' : path.startsWith('/docs/') ? path.split('/')[2] : path === '/' ? 'home' : path.slice(1);
  if (path === '/nodes') section = { '原创体系': 'original', Wizard: 'wizard', '他山之玉': 'external' }[currentRoute.params.get('collection')] || 'nodes';
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    const active = link.dataset.section === section;
    link.classList.toggle('is-active', active);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const globalInput = document.querySelector('#global-search input[name="q"]');
  if (globalInput && document.activeElement !== globalInput) globalInput.value = currentRoute.params.get('q') || '';
}

async function render({ focusId = null, selection = null, scroll = true } = {}) {
  const version = ++renderVersion;
  currentRoute = parseRoute();
  updateShell(currentRoute.path);
  closeMenu();
  app.setAttribute('aria-busy', 'true');
  app.innerHTML = '<div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span><p>正在读取研究资料…</p></div>';
  try {
    let html;
    const { path, params } = currentRoute;
    if (path === '/' || path === '') html = homePage();
    else if (path === '/nodes') html = nodesPage(params);
    else if (path.startsWith('/node/')) html = await nodePage(decodeURIComponent(path.slice(6)));
    else if (path === '/glossary') html = await glossaryPage(params);
    else if (path === '/sources') html = sourcesPage(params);
    else if (path.startsWith('/source/')) html = sourcePage(decodeURIComponent(path.slice(8)), params);
    else if (path === '/map') html = await mapPage(params);
    else if (path.startsWith('/docs/')) html = await docsPage(path.slice(6), params);
    else html = `${titleBlock('页面不存在', '可使用侧栏导航继续浏览研究库。')}<a class="button" href="#/">返回首页</a>`;
    if (version !== renderVersion) return;
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    document.title = `${app.querySelector('h1')?.textContent || '研究库'} · OW2 竞技学`;
    if (focusId) {
      const target = document.getElementById(focusId);
      target?.focus({ preventScroll: true });
      if (selection != null && typeof target?.setSelectionRange === 'function' && !['select-one', 'select-multiple'].includes(target.type)) target.setSelectionRange(selection, selection);
    } else if (scroll) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      app.focus({ preventScroll: true });
    }
  } catch (error) {
    if (version !== renderVersion) return;
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = `<div class="error-state" role="alert"><h1>暂时无法读取这份资料</h1><p>${esc(error.message)}</p><p>可重试，或回到首页选择其他主题。</p><div class="header-actions"><button class="button" data-retry>重新读取</button><a class="button button-secondary" href="#/">返回首页</a></div></div>`;
  }
}

app.addEventListener('input', event => {
  if (event.target.dataset.queryKey) {
    clearTimeout(queryTimer);
    if (event.isComposing || composingSearch) return;
    const key = event.target.dataset.queryKey;
    const value = event.target.value;
    queryTimer = setTimeout(() => setQuery(key, value, { replace: true, keepFocus: true }), 150);
  }
});
app.addEventListener('compositionstart', event => {
  if (event.target.dataset.queryKey) { composingSearch = true; clearTimeout(queryTimer); }
});
app.addEventListener('compositionend', event => {
  if (!event.target.dataset.queryKey) return;
  composingSearch = false;
  clearTimeout(queryTimer);
  const key = event.target.dataset.queryKey;
  const value = event.target.value;
  queryTimer = setTimeout(() => setQuery(key, value, { replace: true, keepFocus: true }), 150);
});
app.addEventListener('change', event => {
  if (event.target.dataset.filter) setQuery(event.target.dataset.filter, event.target.value, { keepFocus: true });
});
app.addEventListener('click', async event => {
  const button = event.target.closest('button, a[data-open-section]');
  if (!button) return;
  if (button.dataset.page) setQuery('page', button.dataset.page);
  if (button.dataset.removeFilter) setQuery(button.dataset.removeFilter, '');
  if (button.hasAttribute('data-clear-filters')) {
    const kept = currentRoute.path === '/map' && currentRoute.params.get('node') ? { node: currentRoute.params.get('node') } : {};
    history.pushState(null, '', routeUrl(currentRoute.path, kept));
    render();
  }
  if (button.hasAttribute('data-retry')) render();
  if (button.dataset.mapAll) setQuery('all', button.dataset.mapAll === '1' ? '1' : '');
  if (button.dataset.copyNode) {
    const url = new URL(location.href);
    url.hash = routeUrl(`/node/${button.dataset.copyNode}`).slice(1);
    try {
      await navigator.clipboard.writeText(url.href);
      button.textContent = '链接已复制';
      const status = document.querySelector('#copy-status');
      if (status) status.textContent = '节点链接已复制到剪贴板';
      setTimeout(() => { if (button.isConnected) button.textContent = '复制节点链接'; }, 2200);
    } catch {
      button.textContent = '复制受限：请复制地址栏链接';
      const status = document.querySelector('#copy-status');
      if (status) status.textContent = '浏览器禁止复制。当前地址栏即为节点链接。';
    }
  }
  if (button.dataset.openSection) {
    event.preventDefault();
    const section = document.getElementById(`section-${button.dataset.openSection}`);
    if (section) { section.open = true; section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
});
app.addEventListener('toggle', async event => {
  const details = event.target;
  if (!details.open || !details.dataset.docSection) return;
  const slug = currentRoute.path.startsWith('/docs/') ? currentRoute.path.slice(6) : null;
  if (!slug) return;
  const body = details.querySelector('[data-doc-body]');
  try {
    const document = await getData(`docs/${slug}.json`);
    if (!details.isConnected || currentRoute.path !== `/docs/${slug}`) return;
    const section = arr(document.sections).find(row => row.id === details.dataset.docSection);
    if (body && section && !body.dataset.loaded) { body.innerHTML = safeDocumentHtml(section.html); body.dataset.loaded = '1'; }
  } catch { /* The page-level loader presents any fetch error before details are rendered. */ }
}, true);
app.addEventListener('submit', event => {
  if (event.target.id !== 'map-focus-form') return;
  event.preventDefault();
  const value = new FormData(event.target).get('node');
  const upper = String(value || '').trim().toUpperCase();
  const match = nodeIndex.has(upper) ? nodeIndex.get(upper) : rankNodes(nodes, value)[0];
  if (match) {
    history.pushState(null, '', routeUrl('/map', { node: match.id }));
    render();
  } else {
    const input = document.querySelector('#map-focus');
    input.setCustomValidity('没有找到这个编号或关键词，请换一个主题。');
    input.reportValidity();
    input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
  }
});
document.querySelector('#global-search')?.addEventListener('submit', event => {
  event.preventDefault();
  history.pushState(null, '', routeUrl('/nodes', { q: new FormData(event.target).get('q') || '' }));
  render();
});
document.querySelector('#menu-toggle')?.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  document.querySelector('#sidebar')?.classList.toggle('open', open);
  document.querySelector('#menu-toggle')?.setAttribute('aria-expanded', String(open));
  document.querySelector('#menu-toggle')?.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  const overlay = document.querySelector('#menu-overlay');
  if (overlay) { overlay.hidden = !open; overlay.setAttribute('aria-hidden', String(!open)); }
  if (open) document.querySelector('#sidebar a')?.focus();
});
document.querySelector('#menu-overlay')?.addEventListener('click', closeMenu);
document.querySelector('#sidebar')?.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('menu-open')) { closeMenu(); document.querySelector('#menu-toggle')?.focus(); }
  if (event.key === 'Tab' && document.body.classList.contains('menu-open')) {
    const focusables = [...document.querySelectorAll('#sidebar a[href], #menu-toggle')];
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); document.querySelector('#global-search input[name="q"]')?.focus(); }
});
document.querySelector('.skip-link')?.addEventListener('click', event => {
  event.preventDefault();
  app.focus();
  app.scrollIntoView({ block: 'start' });
});
window.addEventListener('resize', () => { if (window.innerWidth > 760 && document.body.classList.contains('menu-open')) closeMenu(); });
window.addEventListener('hashchange', () => { clearTimeout(queryTimer); render(); });
window.addEventListener('popstate', () => { clearTimeout(queryTimer); render(); });

async function start() {
  app.setAttribute('tabindex', '-1');
  app.innerHTML = '<div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span><p>正在打开竞技学研究库…</p></div>';
  try {
    [manifest, nodes, sourceRows] = await Promise.all([getData('manifest.json'), getData('nodes.json'), getData('sources.json')]);
    nodeIndex = new Map(nodes.map(node => [node.id, node]));
    sourceIndex = new Map(sourceRows.map(source => [source.id, source]));
    const counts = document.querySelector('#site-counts');
    if (counts) counts.textContent = `${number(manifest.counts.nodes)} 节点 · ${number(manifest.counts.relations)} 关系`;
    const date = document.querySelector('#site-updated');
    if (date) date.textContent = `更新于 ${manifest.date || String(manifest.updatedAt || '').slice(0, 10)}`;
    await render();
  } catch (error) {
    app.innerHTML = `<div class="error-state" role="alert"><h1>知识库暂时未能打开</h1><p>${esc(error.message)}</p><button class="button" id="start-retry">重新打开</button></div>`;
    document.querySelector('#start-retry')?.addEventListener('click', start);
  }
}
start();
