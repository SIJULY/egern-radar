/*
 * 中国电信小组件（Egern 版，单文件双模式）
 * 移植自 Scriptable 版 ChinaTelecom_2024（作者 2Ya&脑瓜）
 *
 * 同一个文件，两种用法（在 Egern 里建两个脚本条目，脚本 URL 填同一个）：
 *   1. generic 类型 → iOS 小组件：显示剩余话费 / 剩余（或已用）流量 / 剩余语音
 *   2. request 类型 → 登录捕获：Safari 里登录 e.dlife.cn 成功时自动捕获登录地址，
 *      存入存储，小组件下次运行自动读取登录，全程无需手动复制粘贴。
 *
 * 环境变量（在模块/小组件的 Env 中配置）：
 *   CT_LOGIN_URL            电信登录地址（抓包得到的登录 URL，用于自动更新 cookie）
 *   CT_COOKIE               直接填写 cookie（与 CT_LOGIN_URL 二选一，URL 优先）
 *   CT_SHOW_USED_FLOW       'true' 显示已用流量，否则显示剩余流量
 *   CT_FILTER_ORIENTATE_FLOW 'true' 过滤定向流量
 *   CT_TITLE                小组件标题，默认 "中国电信"
 *
 * 数据来源：https://e.dlife.cn/user/package_detail.do
 *           https://e.dlife.cn/user/balance.do
 */

const URLS = {
  login: 'https://e.dlife.cn/index.do',
  detail: 'https://e.dlife.cn/user/package_detail.do',
  balance: 'https://e.dlife.cn/user/balance.do',
};

const FLOW_COLOR = '#FF6620';
const VOICE_COLOR = '#78C100';

/* ---------- 工具函数 ---------- */

function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

function formatFlow(flow) {
  const remain = flow / 1024; // 接口单位换算：与原版保持一致
  if (remain < 1024) return { amount: remain.toFixed(2), unit: 'MB' };
  return { amount: (remain / 1024).toFixed(2), unit: 'GB' };
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ---------- 数据层 ---------- */

async function refreshCookie(ctx) {
  // 登录地址来源：Env 的 CT_LOGIN_URL 优先，其次用捕获脚本存下的地址
  const loginUrl =
    (ctx.env.CT_LOGIN_URL || '').trim() || ctx.storage.get('ct_login_url') || '';
  if (!loginUrl) return ctx.storage.get('ct_cookie') || '';
  const url = (loginUrl.match(/(http.+)&sign/) || [])[1] || loginUrl;
  const resp = await ctx.http.get(url, {
    redirect: 'manual',
    timeout: 15000,
    credentials: 'omit',
  });
  const setCookies = (resp.headers && resp.headers.getAll('set-cookie')) || [];
  const pairs = setCookies
    .map((c) => String(c).split(';')[0].trim())
    .filter(Boolean);
  if (pairs.length > 0) {
    ctx.storage.set('ct_cookie', pairs.join('; '));
  }
  return ctx.storage.get('ct_cookie') || '';
}

async function fetchJson(ctx, url, cookie) {
  const resp = await ctx.http.get(url, {
    headers: { Cookie: cookie },
    timeout: 15000,
    credentials: 'omit',
  });
  if (!resp || resp.status !== 200) {
    throw new Error(`HTTP ${resp ? resp.status : 'no-response'}: ${url}`);
  }
  return await resp.json();
}

// 解析套餐详情 + 余额，逻辑与原 Scriptable 版保持一致
function parseTelecom(detail, balance, opts) {
  const { showUsedFlow, filterOrientateFlow } = opts;
  let totalFlowAmount = 0;
  let totalBalanceFlowAmount = 0;
  let totalUsedFlowAmount = 0;
  let totalVoiceAmount = 0;
  let totalBalanceVoiceAmount = 0;
  let isUnlimitedFlow = false;

  for (const data of detail?.items || []) {
    if (data.offerType === 19) continue;
    for (const item of data.items || []) {
      if (item.unitTypeId == 3) {
        if (!(item.usageAmount == 0 && item.balanceAmount == 0)) {
          const isDirectional = /定向/.test(item.ratableResourcename || '');
          const skip =
            item.balanceAmount == '999999999999' ||
            (filterOrientateFlow && isDirectional);
          if (!skip) {
            totalFlowAmount += parseFloat(item.ratableAmount) || 0;
            totalBalanceFlowAmount += parseFloat(item.balanceAmount) || 0;
          }
        }
        totalUsedFlowAmount += parseFloat(item.usageAmount) || 0;
        if (data.offerType == 21 && item.ratableAmount == '0') {
          isUnlimitedFlow = true;
        }
      } else if (!detail.voiceBalance && item.unitTypeId == 1) {
        totalVoiceAmount += parseInt(item.ratableAmount, 10) || 0;
        totalBalanceVoiceAmount += parseInt(item.balanceAmount, 10) || 0;
      }
    }
  }
  if (detail.voiceAmount && detail.voiceBalance) {
    totalVoiceAmount = detail.voiceAmount;
    totalBalanceVoiceAmount = detail.voiceBalance;
  }

  const balanceFlow = formatFlow(totalBalanceFlowAmount);
  const usedFlow = formatFlow(totalUsedFlowAmount);

  const flow = {
    title: '剩余流量',
    number: balanceFlow.amount,
    unit: balanceFlow.unit,
    percent: +(((totalBalanceFlowAmount / (totalFlowAmount || 1)) * 100).toFixed(2)),
    color: FLOW_COLOR,
  };
  if (showUsedFlow) {
    flow.title = '已用流量';
    flow.number = usedFlow.amount;
    flow.unit = usedFlow.unit;
  }
  if (isUnlimitedFlow) {
    flow.title = '已用流量';
    flow.number = usedFlow.amount;
    flow.unit = usedFlow.unit;
  }

  const voice = {
    title: '剩余语音',
    number: `${totalBalanceVoiceAmount}`,
    unit: '分钟',
    percent: +(((totalBalanceVoiceAmount / (totalVoiceAmount || 1)) * 100).toFixed(2)),
    color: VOICE_COLOR,
  };

  const feeNum = Number(balance?.totalBalanceAvailable);
  const fee = {
    title: '剩余话费',
    number: Number.isFinite(feeNum) ? (feeNum / 100).toFixed(2) : '0.00',
    unit: '元',
  };

  return { fee, flow, voice, updatedAt: Date.now() };
}

async function tryCookie(ctx, cookie, settings) {
  const detail = await fetchJson(ctx, URLS.detail, cookie);
  const balance = await fetchJson(ctx, URLS.balance, cookie);
  const ds = parseTelecom(detail, balance, settings);
  ctx.storage.setJSON('ct_datasource', ds);
  return ds;
}

async function loadData(ctx) {
  const envCookie = (ctx.env.CT_COOKIE || '').trim();
  const loginUrl =
    (ctx.env.CT_LOGIN_URL || '').trim() || ctx.storage.get('ct_login_url') || '';
  const settings = {
    showUsedFlow: ctx.env.CT_SHOW_USED_FLOW === 'true',
    filterOrientateFlow: ctx.env.CT_FILTER_ORIENTATE_FLOW === 'true',
  };
  const storedCookie = ctx.storage.get('ct_cookie') || '';
  // 只要配了登录地址/cookie，或之前抓到过 cookie，就视为"已配置"
  const configured = !!(envCookie || loginUrl || storedCookie);

  // 1) 优先用已捕获的 cookie（从登录后的真实请求里抓的，最可靠）
  const firstCookie = envCookie || storedCookie;
  if (firstCookie) {
    try {
      const ds = await tryCookie(ctx, firstCookie, settings);
      return { configured, ds, fromCache: false };
    } catch (e) {
      /* cookie 失效，掉到下一步 */
    }
  }

  // 2) 回放登录地址刷新 cookie（备用方式）
  if (!envCookie && loginUrl) {
    try {
      const fresh = await refreshCookie(ctx);
      if (fresh && fresh !== firstCookie) {
        const ds = await tryCookie(ctx, fresh, settings);
        return { configured, ds, fromCache: false };
      }
    } catch (e) {
      /* 掉到缓存 */
    }
  }

  // 3) 断网/过期时用缓存顶一下
  const cached = ctx.storage.getJSON('ct_datasource');
  return { configured, ds: cached || null, fromCache: !!cached };
}

/* ---------- 渲染层（Widget DSL） ---------- */

// SVG 进度圆环（Egern 2.20+ 支持内联 SVG 矢量渲染）
function ringSVG({ percent, size = 64, strokeWidth = 9, color }) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const offset = c * (1 - p / 100);
  const fg = hexToRgb(color);
  const track = fg.replace('rgb(', 'rgba(').replace(')', ',0.18)');
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>` +
    `<circle cx='${size / 2}' cy='${size / 2}' r='${r}' fill='none' stroke='${track}' stroke-width='${strokeWidth}'/>` +
    `<circle cx='${size / 2}' cy='${size / 2}' r='${r}' fill='none' stroke='${fg}' stroke-width='${strokeWidth}'` +
    ` stroke-linecap='round' stroke-dasharray='${c.toFixed(2)}' stroke-dashoffset='${offset.toFixed(2)}'` +
    ` transform='rotate(-90 ${size / 2} ${size / 2})'/>` +
    `</svg>`;
  return 'data:image/svg+xml,' + svg;
}

function ringCard(data, ringSize) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    gap: 2,
    flex: 1,
    children: [
      {
        type: 'image',
        src: ringSVG({ percent: data.percent, size: ringSize, color: data.color }),
        width: ringSize,
        height: ringSize,
      },
      {
        type: 'text',
        text: `${data.number} ${data.unit}`,
        font: { size: 'subheadline', weight: 'semibold' },
        textAlign: 'center',
        maxLines: 1,
        minScale: 0.6,
      },
      {
        type: 'text',
        text: data.title,
        font: { size: 'caption2' },
        textAlign: 'center',
        opacity: 0.6,
      },
    ],
  };
}

function headerRow(title, ds, fromCache) {
  const t = ds && ds.updatedAt ? fmtTime(ds.updatedAt) : '--:--';
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    children: [
      { type: 'text', text: title, font: { size: 'footnote', weight: 'semibold' } },
      { type: 'spacer' },
      {
        type: 'text',
        text: fromCache ? `缓存 ${t}` : `更新 ${t}`,
        font: { size: 'caption2' },
        opacity: 0.55,
      },
    ],
  };
}

function buildSmall(title, ds, fromCache) {
  return {
    type: 'widget',
    padding: 14,
    gap: 8,
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children: [
      headerRow(title, ds, fromCache),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        children: [
          { type: 'text', text: ds.fee.title, font: { size: 'footnote' }, opacity: 0.65 },
          { type: 'spacer' },
          { type: 'text', text: ds.fee.number, font: { size: 'title2', weight: 'bold' } },
          {
            type: 'text',
            text: ` ${ds.fee.unit}`,
            font: { size: 'footnote' },
            opacity: 0.65,
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        gap: 10,
        children: [ringCard(ds.flow, 58), ringCard(ds.voice, 58)],
      },
    ],
  };
}

function buildMedium(title, ds, fromCache) {
  const card = (children) => ({
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    flex: 1,
    padding: 10,
    borderRadius: 12,
    backgroundColor: { light: '#F2F2F7', dark: '#1C1C1E' },
    children,
  });
  return {
    type: 'widget',
    padding: 12,
    gap: 8,
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children: [
      headerRow(title, ds, fromCache),
      {
        type: 'stack',
        direction: 'row',
        gap: 8,
        children: [
          card([
            { type: 'text', text: ds.fee.title, font: { size: 'caption1' }, opacity: 0.65 },
            { type: 'spacer', length: 10 },
            { type: 'text', text: ds.fee.number, font: { size: 'title', weight: 'bold' } },
            { type: 'text', text: ds.fee.unit, font: { size: 'footnote' }, opacity: 0.65 },
            { type: 'spacer', length: 10 },
          ]),
          card([
            {
              type: 'image',
              src: ringSVG({ percent: ds.flow.percent, size: 62, color: ds.flow.color }),
              width: 62,
              height: 62,
            },
            {
              type: 'text',
              text: `${ds.flow.number} ${ds.flow.unit}`,
              font: { size: 'subheadline', weight: 'semibold' },
              textAlign: 'center',
              maxLines: 1,
              minScale: 0.6,
            },
            { type: 'text', text: ds.flow.title, font: { size: 'caption2' }, opacity: 0.6 },
          ]),
          card([
            {
              type: 'image',
              src: ringSVG({ percent: ds.voice.percent, size: 62, color: ds.voice.color }),
              width: 62,
              height: 62,
            },
            {
              type: 'text',
              text: `${ds.voice.number} ${ds.voice.unit}`,
              font: { size: 'subheadline', weight: 'semibold' },
              textAlign: 'center',
              maxLines: 1,
              minScale: 0.6,
            },
            { type: 'text', text: ds.voice.title, font: { size: 'caption2' }, opacity: 0.6 },
          ]),
        ],
      },
    ],
  };
}

function buildLockScreen(title, ds, family) {
  if (family === 'accessoryCircular' || family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: `¥${ds.fee.number}`,
          font: { size: 'body', weight: 'semibold' },
          textAlign: 'center',
        },
      ],
    };
  }
  // accessoryRectangular
  return {
    type: 'widget',
    padding: 8,
    gap: 4,
    children: [
      { type: 'text', text: title, font: { size: 'caption2', weight: 'semibold' } },
      {
        type: 'text',
        text: `¥${ds.fee.number} · ${ds.flow.number}${ds.flow.unit} · ${ds.voice.number}分`,
        font: { size: 'footnote' },
        maxLines: 1,
        minScale: 0.6,
      },
    ],
  };
}

function buildError(title, message, url) {
  const w = {
    type: 'widget',
    padding: 14,
    gap: 6,
    children: [
      { type: 'text', text: title, font: { size: 'footnote', weight: 'semibold' } },
      {
        type: 'image',
        src: 'sf-symbol:exclamationmark.triangle',
        width: 22,
        height: 22,
        color: '#FF9500',
      },
      { type: 'text', text: message, font: { size: 'caption1' }, opacity: 0.7 },
    ],
  };
  if (url) w.url = url; // 点小组件直接跳转（比如跳到登录页）
  return w;
}

/* ---------- 登录捕获（request 脚本模式） ---------- */

// 在 Safari/浏览器里登录 e.dlife.cn 成功时，Egern 会经过 loginMiddle 请求，
// 在此自动捕获登录地址存入存储，小组件下次运行自动读取，全程无需手动操作。
// 不返回值 = 透传，不影响登录请求本身。
/* 从请求头里取 Cookie，兼容 plain object / Headers 实例等形态，忽略大小写 */
function getReqCookie(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get('cookie') || headers.get('Cookie') || '';
  }
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === 'cookie') return headers[k] || '';
  }
  return '';
}

async function handleCapture(ctx) {
  const req = ctx.request || {};
  const url = req.url || '';
  if (!url.includes('e.dlife.cn')) return; // 非电信请求直接透传

  // 1) 登录握手地址：记下来，并标记"刚刚登录过"（10 分钟内有效）
  if (url.includes('/user/loginMiddle')) {
    const loginUrl = (url.match(/(http.+)&sign/) || [])[1] || url;
    if (loginUrl && ctx.storage.get('ct_login_url') !== loginUrl) {
      ctx.storage.set('ct_login_url', loginUrl);
    }
    ctx.storage.set('ct_login_ts', String(Date.now()));
    return;
  }

  // 2) 主要方式：直接从登录后的真实请求里抓 Cookie，比回放握手地址可靠
  const cookie = String(getReqCookie(req.headers) || '').trim();
  if (!cookie || ctx.storage.get('ct_cookie') === cookie) return;
  ctx.storage.set('ct_cookie', cookie);

  // 只有"刚登录过"才打扰用户（成功信号）；后台静默续期不通知
  const ts = Number(ctx.storage.get('ct_login_ts') || 0);
  if (Date.now() - ts < 10 * 60 * 1000) {
    ctx.storage.delete('ct_login_ts');
    ctx.notify({
      title: '中国电信',
      body: '登录成功，小组件将自动更新',
      // 兜底：如果小组件没自动读到，点通知手动复制 cookie
      action: { type: 'clipboard', text: cookie },
    });
  }
}

/* ---------- 小组件（generic 脚本模式） ---------- */

async function handleWidget(ctx) {
  const title = (ctx.env.CT_TITLE || '中国电信').trim() || '中国电信';
  const { configured, ds, fromCache } = await loadData(ctx);

  if (!configured) {
    return buildError(
      title,
      '未登录：点我去登录，短信验证一次即可',
      URLS.login
    );
  }
  if (!ds) {
    return buildError(title, '数据获取失败，请检查网络或重新登录');
  }

  const family = ctx.widgetFamily || 'systemSmall';
  if (family === 'systemMedium' || family === 'systemLarge' || family === 'systemExtraLarge') {
    return buildMedium(title, ds, fromCache);
  }
  if (family.startsWith('accessory')) {
    return buildLockScreen(title, ds, family);
  }
  return buildSmall(title, ds, fromCache);
}

/* ---------- 入口：单文件双模式 ---------- */

export default async function (ctx) {
  // request 脚本条目 → 捕获登录；generic 脚本条目 → 渲染小组件
  //（ctx.request 仅在 request/response 脚本中可用）
  if (ctx.request && ctx.request.url) {
    return handleCapture(ctx);
  }
  return handleWidget(ctx);
}
