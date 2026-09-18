/**
 * 网络诊断雷达 — Egern 原生 Widget DSL。
 * 延续 Network-Pro.js 衍生版的蓝色本地 / 紫色代理布局。
 * 出口信息来自同一响应；服务标记表示 HTTP 探测，不承诺播放或账号可用。
 */
const CACHE_KEY = 'NetworkRadar.v2.3';
const SERVICE_IDS = ['NF', 'DP', 'TK', 'GPT', 'CL', 'GM'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const C = {
  ink: { light: '#202C40', dark: '#F4F7FB' }, dim: { light: '#56647A', dark: '#ADBBD0' },
  blue: { light: '#1763BE', dark: '#83BAFF' }, purple: { light: '#8642B5', dark: '#CBA2FF' },
  green: { light: '#24713E', dark: '#67DB91' }, amber: { light: '#8B5909', dark: '#F2C56D' },
  red: { light: '#B73037', dark: '#FF9298' }, fill: { light: '#E7ECF3', dark: '#263143' },
  bg: { light: '#F6F8FD', dark: '#111318' },
  glowBlue: { light: '#E5EDFC', dark: '#172B44' }, glowPurple: { light: '#F0E9F9', dark: '#241D33' },
  localFill: { light: '#E0ECFC', dark: '#1B2B43' }, proxyFill: { light: '#EDE3F8', dark: '#2C2340' },
  localHeading: { light: '#C9DFF9', dark: '#263F5E' }, proxyHeading: { light: '#DFCEF2', dark: '#41305A' },
  greenFill: { light: '#DDEEE3', dark: '#20382F' }, amberFill: { light: '#F3E8D2', dark: '#3C3323' },
  redFill: { light: '#F7DFE2', dark: '#43282E' },
};
function clean(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function ipAddress(value) {
  const ip = clean(value, 64);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split('.').every(p => Number(p) <= 255) ? ip : '';
  if (!/^[\da-f:]+$/i.test(ip) || !ip.includes(':') || ip.includes(':::')) return '';
  const halves = ip.split('::'), parts = ip.split(':').filter(Boolean);
  if (halves.length > 2 || halves.some(h => h && !/^[\da-f]{1,4}(:[\da-f]{1,4})*$/i.test(h))) return '';
  if (halves.length === 1 ? parts.length !== 8 || ip.startsWith(':') || ip.endsWith(':') : parts.length >= 8) return '';
  return ip.toLowerCase();
}
function country(value) { return /^[A-Z]{2}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : ''; }
function ipv4Address(value) { const ip = ipAddress(value); return ip && !ip.includes(':') ? ip : ''; }
function asn(value) { const s = String(value || '').replace(/^AS/i, ''); return /^\d{1,10}$/.test(s) ? `AS${s}` : ''; }
function carrier(value) {
  const s = clean(value);
  if (/cmcc|cmnet|china mobile|移动/i.test(s)) return '中国移动';
  if (/chinanet|china telecom|电信/i.test(s)) return '中国电信';
  if (/unicom|cncgroup|联通/i.test(s)) return '中国联通';
  if (/china broadnet|广电/i.test(s)) return '中国广电';
  return s || '未知';
}
function numberOption(value, fallback, min, max) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function network(ctx) {
  const d = ctx.device || {}, legacy = ctx.network?.v4 || {};
  const wifi = clean(d.wifi?.ssid), radio = clean(d.cellular?.radio);
  const label = wifi || ({ LTE: '4G', NR: '5G', NRNSA: '5G', WCDMA: '3G' }[radio.toUpperCase()] || radio || '未知网络');
  const local = ipAddress(d.ipv4?.address || legacy.primaryAddress) || '未知';
  const gateway = ipAddress(d.ipv4?.gateway || legacy.primaryRouter) || (radio ? '蜂窝内网' : '未知');
  return { label, local, gateway, wifi: !!wifi, identity: JSON.stringify([
    wifi, clean(d.wifi?.bssid), radio, clean(d.cellular?.carrier), local, gateway,
    clean(d.ipv4?.interface), clean(d.ipv6?.address), clean(d.ipv6?.interface),
  ]) };
}
async function readCache(ctx, scope) {
  try {
    const raw = await ctx.storage?.get(CACHE_KEY), cache = typeof raw === 'string' ? JSON.parse(raw) : null;
    return cache?.scope === scope ? cache : { scope };
  } catch { return { scope }; }
}
async function saveCache(ctx, cache) {
  try { await ctx.storage?.set(CACHE_KEY, JSON.stringify(cache)); } catch { /* Cache is optional. */ }
}
function fresh(record, ttl, now) { return ttl > 0 && record?.at > 0 && now >= record.at && now - record.at < ttl * 1000; }
async function request(ctx, url, policy, timeout = 4000) {
  try {
    const r = await ctx.http.get(url, { policy, timeout, redirect: 'manual', credentials: 'omit', headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
    const body = typeof r.text === 'function' ? await r.text() : typeof r.body === 'string' ? r.body : '';
    return { status: Number(r.status), body, location: clean(r.headers?.get?.('location') || r.headers?.location || r.headers?.Location, 1000) };
  } catch { return null; }
}
async function jsonRequest(ctx, url, policy) {
  const r = await request(ctx, url, policy);
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}
async function latency(ctx, url, policy) {
  const start = Date.now(), r = await request(ctx, url, policy, 2000);
  return r && r.status >= 200 && r.status < 400 ? `${Date.now() - start} ms` : '超时';
}
async function localInfo(ctx) {
  const [j, delay] = await Promise.all([jsonRequest(ctx, 'https://myip.ipip.net/json', 'DIRECT'), latency(ctx, 'https://www.baidu.com', 'DIRECT')]);
  const loc = Array.isArray(j?.data?.location) ? j.data.location : [];
  return { ip: ipAddress(j?.data?.ip), location: [clean(loc[1]), clean(loc[2])].filter(Boolean).join(' · '), organization: carrier(loc[loc.length - 1]), delay };
}
async function proxyInfo(ctx, policy) {
  // IPPure's IPv4 mirror is also used by clash-ip-checker. Validate the response
  // family even if its DNS changes; never accept IPv6 quality data in this view.
  const [first, delay] = await Promise.all([jsonRequest(ctx, 'https://my.123169.xyz/v1/info', policy), latency(ctx, 'https://cp.cloudflare.com/generate_204', policy)]);
  const j = ipv4Address(first?.ip) ? first : await jsonRequest(ctx, 'https://my.ippure.com/v1/info', policy);
  const ip = ipv4Address(j?.ip);
  if (ip) {
    // These fields describe this exact response's IP. Never mix another self-IP lookup.
    const score = typeof j.fraudScore === 'number' && Number.isFinite(j.fraudScore) && j.fraudScore >= 0 && j.fraudScore <= 100 ? j.fraudScore : null;
    return { ip, cc: country(j.countryCode), location: [clean(j.country), clean(j.city)].filter(Boolean).join(' · '), asn: asn(j.asn), organization: clean(j.asOrganization),
      residential: typeof j.isResidential === 'boolean' ? j.isResidential : null, score, source: 'IPPure', delay };
  }
  // Legacy free endpoint is only a fallback. It cannot supply an IPPure score.
  const fallback = await jsonRequest(ctx, 'http://ip-api.com/json/?lang=zh-CN', policy);
  const fallbackIP = fallback?.status === 'success' ? ipv4Address(fallback.query) : '';
  if (!fallbackIP) return { ip: '', cc: '', location: '', asn: '', organization: '', residential: null, score: null, source: '', delay };
  return { ip: fallbackIP, cc: country(fallback?.countryCode),
    location: [clean(fallback?.country), clean(fallback?.city)].filter(Boolean).join(' · '), asn: asn(String(fallback?.as || '').split(' ')[0]),
    organization: clean(fallback?.org || fallback?.isp), residential: null, score: null, source: 'ip-api', delay };
}
const unknown = (reason = 'unrecognized') => ({ state: 'unknown', cc: '', reason });
function challengePage(body) {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const visible = body.length < 1000 ? body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').trim() : '';
  // Normal Netflix/Disney/TikTok pages include CAPTCHA libraries/translations.
  // A bare substring is not evidence that the response is a challenge page.
  return /just a moment|attention required|access denied|verify.*human|security check|captcha/i.test(title) ||
    /<form[^>]+id=["']challenge-form["']|window\._cf_chl_opt\s*=/i.test(body) ||
    /just a moment|checking your browser|^captcha$|access denied/i.test(visible);
}
function serviceURL(location, base, domains) {
  const origin = base.match(/^https:\/\/[^/]+/i)?.[0];
  if (!origin || !location || /[\s\\]/.test(location)) return '';
  const target = location.startsWith('//') ? `https:${location}` : location.startsWith('/') ? origin + location
    : /^https:\/\//i.test(location) ? location : /^[a-z][a-z\d+.-]*:/i.test(location) ? ''
    : location.startsWith('?') ? base.split('?')[0] + location : base.replace(/[^/]*$/, '') + location;
  const host = target.match(/^https:\/\/([a-z\d.-]+)(?=\/|\?|#|$)/i)?.[1]?.toLowerCase();
  return host && domains.some(d => host === d || host.endsWith('.' + d)) ? target.split('#')[0] : '';
}
async function serviceRequest(ctx, url, policy, domains) {
  const deadline = Date.now() + 7000, seen = new Set();
  for (let hop = 0; hop < 4; hop++) {
    if (seen.has(url)) return { reason: 'redirect', status: 0, body: '' };
    seen.add(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { reason: 'timeout', status: 0, body: '' };
    const r = await request(ctx, url, policy, Math.min(remaining, 4000));
    if (!r) return { reason: 'connection', status: 0, body: '' };
    r.url = url;
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    if (/\/(?:unavailable|unsupported-country)(?:[/?#]|$)/i.test(r.location)) return r;
    const next = serviceURL(r.location, url, domains);
    if (!next) return { ...r, reason: 'redirect' };
    url = next;
  }
  return { reason: 'redirect', status: 0, body: '' };
}
function serviceResult(r, id) {
  if (!r) return unknown('connection');
  if (r.reason) return unknown(r.reason);
  const body = (r.body || '').replace(/\\"/g, '"'), location = r.location || '';
  if (r.status === 429) return unknown('rate_limit');
  if (r.status >= 500) return unknown(`http_${r.status}`);
  if (challengePage(body)) return unknown('challenge');
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  if (/\/(?:unavailable|unsupported-country)(?:[/?#]|$)|unsupported.country/i.test(location) ||
    /app unavailable|not available in your (country|region)/i.test(title) ||
    body.length < 2000 && /app unavailable|not available in your (country|region)|not available in certain regions|forbidden-location/i.test(body)) return { state: 'restricted', cc: '' };
  if (r.status !== 200) return unknown(`http_${r.status}`);
  if (!body.trim()) return unknown('empty');
  if (id === 'GPT' || id === 'CL') {
    const cc = country(body.match(/^loc=([A-Z]{2})\s*$/m)?.[1]);
    // Cloudflare trace is regional evidence, not a product unlock test.
    return cc ? { state: 'region', cc } : unknown();
  }
  if (id === 'TK') {
    const cc = country(body.match(/"region"\s*:\s*"([A-Z]{2})(?:-[A-Z\d]+)?"/i)?.[1]);
    return cc ? { state: 'reachable', cc } : unknown();
  }
  if (id === 'DP') {
    const supported = body.match(/"inSupportedLocation"\s*:\s*(true|false)/i)?.[1];
    const cc = country(body.match(/"(?:countryCode|region)"\s*:\s*"([A-Z]{2})"/i)?.[1]);
    if (supported === 'false') return { state: 'restricted', cc };
    if (supported === 'true' || /Disney\+/i.test(title) && cc) return { state: 'reachable', cc };
  }
  if (id === 'GM') {
    const cc = body.match(/,\s*2,\s*1,\s*200,\s*"([A-Z]{3})"/)?.[1];
    if (cc) return { state: 'region', cc };
    if (/BardChatUi|boq_assistant-bard/i.test(body)) return { state: 'reachable', cc: '' };
  }
  if (id === 'NF') {
    const titleID = r.url?.match(/\/title\/(\d+)/)?.[1];
    if (/Netflix/i.test(title) && titleID && body.includes(titleID)) {
      const cc = country(r.url.match(/netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\/title\//i)?.[1]);
      return { state: 'reachable', cc };
    }
  }
  return unknown();
}
async function services(ctx, policy, ids) {
  const endpoints = [['DP', 'https://www.disneyplus.com/', 'disneyplus.com'], ['TK', 'https://www.tiktok.com/', 'tiktok.com'], ['GPT', 'https://chatgpt.com/cdn-cgi/trace', 'chatgpt.com'], ['CL', 'https://claude.ai/cdn-cgi/trace', 'claude.ai'], ['GM', 'https://gemini.google.com/', 'gemini.google.com']];
  const jobs = endpoints.filter(([id]) => ids.includes(id)).map(async ([id, url, domain]) => {
    const r = await serviceRequest(ctx, url, policy, [domain]);
    return [id, serviceResult(r, id)];
  });
  if (ids.includes('NF')) jobs.push((async () => {
    const responses = await Promise.all(['70143836', '81280792'].map(id => serviceRequest(ctx, `https://www.netflix.com/title/${id}`, policy, ['netflix.com'])));
    const [a, b] = responses.map(r => serviceResult(r, 'NF'));
    if (a.state === 'reachable' && b.state === 'reachable') return ['NF', a];
    if ((responses[0]?.status === 404 && b.state === 'reachable') || (responses[1]?.status === 404 && a.state === 'reachable')) return ['NF', { state: 'limited', cc: a.cc || b.cc }];
    if (a.state === 'restricted' || b.state === 'restricted') return ['NF', a.state === 'restricted' ? a : b];
    return ['NF', a.state === 'unknown' ? a : b];
  })());
  return Object.fromEntries(await Promise.all(jobs));
}
export async function collectRadar(ctx) {
  const env = ctx.env || {}, net = network(ctx), now = Date.now();
  const policy = clean(env.RADAR_POLICY, 80) || 'Proxy';
  const force = ctx.script?.name === '网络诊断雷达 · 立即检测';
  const localTTL = numberOption(env.RADAR_LOCAL_CACHE_SECONDS, 60, 0, 600);
  const serviceTTL = numberOption(env.RADAR_SERVICE_CACHE_SECONDS, 600, 0, 3600);
  const scope = JSON.stringify([net.identity, policy]), cache = await readCache(ctx, scope);
  const [local, proxy] = await Promise.all([
    !force && fresh(cache.local, localTTL, now) && cache.local.data?.ip ? cache.local.data : localInfo(ctx),
    proxyInfo(ctx, policy), // Recheck egress even if a group's name is unchanged.
  ]);
  if (local.ip && local !== cache.local?.data) cache.local = { at: now, data: local };
  let checks = Object.fromEntries(SERVICE_IDS.map(id => [id, unknown('no_exit')])), checkedAt = now, cached = false;
  const enabled = String(env.RADAR_SERVICES_ENABLED || 'true') !== 'false';
  if (enabled && proxy.ip) {
    const previous = cache.services?.ip === proxy.ip ? cache.services.data || {} : {};
    const pending = SERVICE_IDS.filter(id => force || !['reachable', 'restricted', 'limited', 'region', 'unknown'].includes(previous[id]?.state) ||
      !fresh(previous[id], previous[id]?.state === 'unknown' ? Math.min(30, serviceTTL) : serviceTTL, now));
    const results = await services(ctx, policy, pending);
    checks = Object.fromEntries(SERVICE_IDS.map(id => [id, pending.includes(id) ? { ...results[id], at: now } : previous[id]]));
    checkedAt = Math.min(...SERVICE_IDS.map(id => checks[id].at));
    cached = pending.length < SERVICE_IDS.length;
    cache.services = { ip: proxy.ip, data: checks };
  } else delete cache.services;
  await saveCache(ctx, cache);
  return { net, local, proxy, policy, checks, checkedAt, cached, enabled, at: now };
}
function displayIP(ip, large, masked) {
  if (!ip) return '未知';
  if (masked && ipAddress(ip)) return ip.includes(':') ? ip.split(':').slice(0, 2).join(':') + ':*' : ip.split('.').slice(0, 2).join('.') + '.*.*';
  if (!large && ip.includes(':') && ip.length > 19) return ip.slice(0, 9) + '…' + ip.slice(-5);
  return ip;
}
function clock(at) { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function compact(value, max) { const s = clean(value); return s.length > max ? s.slice(0, max - 1) + '…' : s || '未知'; }
export function renderRadar(model, ctx) {
  const { net, local, proxy, policy, checks } = model, env = ctx.env || {};
  const hint = 'large'; // Force large layout for fullscreen
  const large = hint === 'large' || (hint !== 'medium' && /large|extra/i.test(ctx.widgetFamily || ctx.family || ctx.widget?.family || ''));
  const masked = String(env.RADAR_MASK_IP || 'false') === 'true', val = x => clean(x) || '未知';
  const tx = (text, size = large ? 11.5 : 10.5, col = C.ink, weight = 'medium') => ({ type: 'text', text: String(text), font: { size, weight }, textColor: col, maxLines: 1 });
  const stack = (children, direction = 'column', gap = 4, more = {}) => ({ type: 'stack', direction, alignItems: direction === 'column' ? 'start' : 'center', gap, children, ...more });
  const icon = (name, col = C.blue, s = large ? 12 : 11) => ({ type: 'image', src: `sf-symbol:${name}`, color: col, width: s, height: s });
  // The root gives remaining height to one flat table. Its row cells have a
  // fixed, readable height; surplus space is shared between data rows, never
  // inflated service cards. Avoid nested flexible columns with intrinsic height.
  const lineHeight = large ? 20 : 13;
  const columnGap = large ? 12 : 10;
  const bounded = (text, size, col = C.ink, weight = 'medium', align = 'right') => ({ ...tx(text, size, col, weight), flex: 1, textAlign: align, minScale: 1 });
  const rowIcons = { 环境: net.wifi ? 'wifi' : 'antenna.radiowaves.left.and.right', 内网: 'iphone', 公网: 'globe.asia.australia.fill', 位置: 'map.fill', 运营: 'antenna.radiowaves.left.and.right', 网关: 'wifi.router.fill', 延迟: 'timer', 出口: 'paperplane.fill', '出口 IP': 'paperplane.fill', 落地: 'mappin.and.ellipse', ASN: 'network', 组织: 'server.rack', 策略: 'arrow.triangle.branch', 来源: 'doc.text.magnifyingglass' };
  const row = (label, value, col = C.blue) => stack([icon(rowIcons[label], col, large ? 12 : 10), tx(label, large ? 11.5 : 10, C.dim), bounded(value, large ? 12 : 10.5)], 'row', 3, { height: lineHeight, flex: 1, padding: [0, 4] });
  const rrow = (label, value) => row(label, value, C.purple);
  const header = stack([icon('waveform.path.ecg', C.blue, large ? 21 : 17), bounded('网络诊断雷达', large ? 20 : 17, C.ink, 'bold', 'left'), tx(proxy.ip ? `${clock(model.at)}${!large && model.cached ? ' · 缓' : ''}` : 'IPv4 未知', 10, proxy.ip ? C.dim : C.amber)], 'row', 6,
    { height: large ? 34 : 30, padding: [0, 0, 8, 0] });
  const localRows = [row('环境', compact(net.label, 22)), row('内网', displayIP(net.local, large, masked)), row('公网', displayIP(local.ip, large, masked)), row('位置', val(local.location)), row('运营', val(local.organization)), ...(large ? [row('网关', displayIP(net.gateway, large, masked))] : []), row('延迟', val(local.delay))];
  const proxyRows = [rrow('出口', displayIP(proxy.ip, large, masked)), rrow('落地', val(proxy.location)), rrow('组织', val(proxy.organization)), rrow('ASN', val(proxy.asn)), rrow('策略', val(policy)), ...(large ? [rrow('来源', val(proxy.source))] : []), rrow('延迟', val(proxy.delay))];
  const columnHeading = (title, name, col) => stack([icon(name, col, 14), bounded(title, 14, col, 'semibold', 'left')], 'row', 5,
    { flex: 1, height: 22, padding: [0, 4], backgroundColor: col === C.blue ? C.localHeading : C.proxyHeading, borderRadius: 6 });
  const columns = stack([
    ...(large ? [stack([columnHeading('本地网络', rowIcons.环境, C.blue), columnHeading('代理出口', 'paperplane.fill', C.purple)], 'row', columnGap, { height: 22 })] : []),
    ...localRows.map((left, i) => stack([left, proxyRows[i]], 'row', columnGap, { flex: 1 })),
  ], 'column', large ? 3 : 1, { flex: 1, borderRadius: 8,
    // Paint behind the flat table; background layers consume no vertical space.
    backgroundGradient: { type: 'linear', colors: [C.localFill, C.localFill, C.proxyFill, C.proxyFill], stops: [0, 0.46, 0.54, 1], startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } } });
  const residential = proxy.residential, score = proxy.score;
  const property = residential === true ? '住宅网络' : residential === false ? '机房 / 商业' : '属性未知';
  const propertyIcon = residential === true ? 'house.fill' : residential === false ? 'building.2.fill' : 'questionmark.circle.fill';
  const propertyColor = residential === true ? C.green : residential === false ? C.amber : C.dim;
  const scoreColor = score === null ? C.dim : score >= 70 ? C.red : score >= 40 ? C.amber : C.green;
  const scoreIcon = score === null ? 'questionmark.shield' : score >= 70 ? 'exclamationmark.shield.fill' : 'checkmark.shield.fill';
  const scoreText = score === null ? '无数据' : `${score} · ${score >= 70 ? '高风险' : score >= 40 ? '中风险' : '低风险'}`;
  const statusFill = col => col === C.green ? C.greenFill : col === C.amber ? C.amberFill : col === C.red ? C.redFill : C.fill;
  const qualityItem = (name, text, col) => stack([icon(name, col, large ? 12 : 10), bounded(text, large ? 11 : 10.5, col, 'medium', 'left')], 'row', 4,
    { flex: 1, height: large ? 22 : 14, padding: [large ? 3 : 0, 4], backgroundColor: statusFill(col), borderRadius: large ? 6 : 5 });
  const quality = stack([qualityItem(propertyIcon, property, propertyColor), qualityItem(scoreIcon, `IPPure ${scoreText}`, scoreColor)], 'row', columnGap,
    { height: large ? 22 : 14 });
  const serviceIcons = { NF: 'film.fill', DP: 'sparkles.tv', TK: 'music.note', GPT: 'bubble.left.and.bubble.right.fill', CL: 'asterisk', GM: 'sparkles' };
  const reasonText = result => ({ no_exit: '未测', challenge: '验证', timeout: '超时', connection: '连接', redirect: '跳转', rate_limit: '限流', empty: '空', unrecognized: '解析' }[result.reason] || (result.reason?.startsWith('http_') ? result.reason.slice(5) : '?'));
  const service = (label, ids) => stack([...(large ? [stack([tx(label, 10, C.dim)], 'row', 0, { width: 22, height: 18 })] : []), ...ids.map(id => {
    const result = checks[id] || unknown();
    const mark = !model.enabled ? '—' : result.state === 'region' ? result.cc : result.state === 'reachable' ? `${result.cc ? result.cc + ' ' : ''}✓` : result.state === 'restricted' ? '×' : result.state === 'limited' ? '◐' : reasonText(result);
    const col = !model.enabled || result.state === 'unknown' ? C.dim : result.state === 'region' ? C.purple : result.state === 'reachable' ? C.green : result.state === 'restricted' ? C.red : C.amber;
    const serviceFill = !model.enabled || result.state === 'unknown' ? C.fill : result.state === 'restricted' ? C.redFill : result.state === 'limited' ? C.amberFill
      : ['NF', 'DP', 'TK'].includes(id) ? C.localFill : C.proxyFill;
    return stack([...(large ? [icon(serviceIcons[id], label === '影视' ? C.blue : C.purple, 12)] : []), bounded(`${id} ${mark}`, large ? 11 : 10, col, 'medium', large ? 'left' : 'center')], 'row', large ? 4 : 0,
      { flex: 1, height: large ? 18 : 14, padding: [0, large ? 4 : 0], borderRadius: 5, backgroundColor: serviceFill });
  })], 'row', large ? 6 : 3, { height: large ? 18 : 14 });
  const servicePanel = large ? stack([service('影视', ['NF', 'DP', 'TK']), service('AI', ['GPT', 'CL', 'GM'])], 'column', 2, { height: 38 })
    : service('', SERVICE_IDS);
  let footer = !model.enabled ? '服务检测已关闭' : !proxy.ip ? 'IPv4 未知 · 未检测服务' : `${model.cached ? '缓存' : '检测'} ${clock(model.checkedAt)} · ✓ 页面 / 地区码不代表解锁`;
  if (large && proxy.ip && proxy.source !== 'IPPure') footer = '备用 IP 来源 · IPPure 评分不可用';
  // Minimum content budgets: medium 152 pt, large 325 pt. Extra height goes
  // to the main table, so 155/170 and 345/376 pt surfaces keep a compact footer.
  return { type: 'widget', padding: large ? [8, 10] : [4, 10], gap: large ? 5 : 1, backgroundColor: C.bg,
    backgroundGradient: { type: 'linear', colors: [C.glowBlue, C.bg, C.glowPurple], stops: [0, 0.55, 1], startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } },
    refreshAfter: new Date(model.at + 60_000).toISOString(), children: [header, columns, quality, servicePanel,
      ...(large ? [stack([icon('clock', C.dim, 10), bounded(footer, 9.5, C.dim, 'medium', 'left')], 'row', 4, { height: 12 })] : [])] };
}
export default async function(ctx) { return renderRadar(await collectRadar(ctx), ctx); }
