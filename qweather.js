// 和风天气·晴雨 - Egern 版
// 移植：小龙女她爸（原 Scripting 版）
// 数据：和风天气 QWeather v7

const API_HOST = 'https://devapi.qweather.com';

async function fetchQWeather(ctx, path, location, key) {
  const url = `${API_HOST}${path}?location=${encodeURIComponent(location)}&key=${encodeURIComponent(key)}&lang=zh&unit=m`;
  const resp = await ctx.http.get(url, { timeout: 10000 });
  const j = JSON.parse(await resp.text());
  if (j.code !== '200') throw new Error(`和风接口返回 ${j.code}`);
  return j;
}

async function getWeatherData(ctx, location, key) {
  const [nowJ, dailyJ, airJ] = await Promise.all([
    fetchQWeather(ctx, '/v7/weather/now', location, key),
    fetchQWeather(ctx, '/v7/weather/7d', location, key).catch(() => null),
    fetchQWeather(ctx, '/v7/air/now', location, key).catch(() => null),
  ]);

  const now = nowJ.now || {};
  const daily = (dailyJ && dailyJ.daily) || [];
  const aqi = airJ && airJ.now ? { value: airJ.now.aqi, label: airJ.now.category } : null;

  return {
    place: location,
    temp: now.temp,
    feelsLike: now.feelsLike,
    text: now.text,
    icon: now.icon,
    humidity: now.humidity,
    windDir: now.windDir,
    windScale: now.windScale,
    vis: now.vis,
    precip: now.precip,
    obsTime: now.obsTime,
    daily: daily,
    aqi: aqi,
  };
}

// 和风图标 code 转 emoji
function weatherEmoji(code) {
  const c = parseInt(code, 10);
  if (c === 100) return '☀️';
  if ([101, 102, 103].includes(c)) return '⛅';
  if (c === 104) return '☁️';
  if (c >= 300 && c <= 318) return '🌧️';
  if (c >= 400 && c <= 499) return '❄️';
  if (c >= 500 && c <= 518) return '🌫️';
  return '⛅';
}

function dayLabel(fxDate) {
  const d = new Date(fxDate + 'T12:00:00');
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
}

function renderMedium(m) {
  const T = { light: '#16324A', dark: '#F2F7FC' };
  const S = { light: '#607287', dark: '#A9B9CD' };
  const BLUE = { light: '#257CC5', dark: '#78B8FF' };

  // 顶部：定位图标 + 城市 | 更新时间
  const header = {
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      { type: 'image', src: 'sf-symbol:location.fill', width: 14, height: 14, color: BLUE },
      { type: 'spacer', length: 4 },
      { type: 'text', text: m.place, font: { size: 15, weight: 'semibold' }, textColor: BLUE, maxLines: 1 },
      { type: 'spacer' },
      { type: 'text', text: m.obsTime ? m.obsTime.slice(11, 16) : '', font: { size: 11 }, textColor: S, maxLines: 1 },
    ],
  };

  // 大温度 + 天气
  const hero = {
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      { type: 'text', text: `${m.temp || '--'}°`, font: { size: 52, weight: 'bold' }, textColor: T, maxLines: 1 },
      { type: 'spacer', length: 10 },
      { type: 'text', text: weatherEmoji(m.icon), font: { size: 40 }, maxLines: 1 },
      { type: 'spacer' },
      {
        type: 'stack', direction: 'column', alignItems: 'end', gap: 2,
        children: [
          { type: 'text', text: m.text || '', font: { size: 16, weight: 'medium' }, textColor: T, maxLines: 1 },
          {
            type: 'stack', direction: 'row', gap: 8,
            children: [
              { type: 'text', text: m.daily[0] ? `高 ${m.daily[0].tempMax}°` : '', font: { size: 13 }, textColor: '#D85D3F', maxLines: 1 },
              { type: 'text', text: m.daily[0] ? `低 ${m.daily[0].tempMin}°` : '', font: { size: 13 }, textColor: '#4879AF', maxLines: 1 },
            ],
          },
        ],
      },
    ],
  };

  // 详情
  const chip = (sym, color, text) => ({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 3,
    children: [
      { type: 'image', src: sym, width: 14, height: 14, color: color },
      { type: 'text', text: text, font: { size: 12 }, textColor: color, maxLines: 1 },
    ],
  });

  const humidity = parseInt(m.humidity, 10) || 0;
  const hbW = 60, hbH = 6, hbF = Math.round(hbW * humidity / 100);
  const hbSvg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${hbW} ${hbH}'><rect x='0' y='0' width='${hbW}' height='${hbH}' rx='3' fill='%23DCE6F1'/><rect x='0' y='0' width='${hbF}' height='${hbH}' rx='3' fill='%23257CC5'/></svg>`;

  const row1 = {
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      chip('sf-symbol:thermometer.medium', '#D8752A', `体感 ${m.feelsLike || '--'}°`),
      { type: 'spacer' },
      chip('sf-symbol:wind', '#188E98', `${m.windDir || ''} ${m.windScale || ''}级`.trim()),
      { type: 'spacer' },
      chip('sf-symbol:aqi.medium', '#23946B', m.aqi ? `AQI ${m.aqi.label} ${m.aqi.value}` : 'AQI --'),
    ],
  };
  const row2 = {
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      chip('sf-symbol:eye', '#6574C7', `能见度 ${m.vis || '--'}km`),
      { type: 'spacer' },
      chip('sf-symbol:cloud.rain.fill', '#1687B8', `降水 ${m.precip || '0'}mm`),
      { type: 'spacer' },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 3,
        children: [
          { type: 'image', src: 'sf-symbol:drop.fill', width: 14, height: 14, color: '#188E98' },
          { type: 'text', text: `湿度${humidity}%`, font: { size: 12 }, textColor: '#188E98', maxLines: 1 },
          { type: 'image', src: `data:image/svg+xml,${hbSvg}`, width: hbW, height: hbH },
        ],
      },
    ],
  };

  // 5 天预报
  const fc = [];
  for (let i = 1; i <= 5 && m.daily[i]; i++) {
    const d = m.daily[i];
    fc.push({
      type: 'stack', direction: 'column', alignItems: 'center', gap: 2,
      children: [
        { type: 'text', text: i === 1 ? '明天' : dayLabel(d.fxDate), font: { size: 12 }, textColor: i === 1 ? BLUE : S, maxLines: 1 },
        { type: 'text', text: weatherEmoji(d.iconDay), font: { size: 22 }, maxLines: 1 },
        {
          type: 'stack', direction: 'row', gap: 4,
          children: [
            { type: 'text', text: `${d.tempMax}°`, font: { size: 13, weight: 'semibold' }, textColor: '#D85D3F', maxLines: 1 },
            { type: 'text', text: `${d.tempMin}°`, font: { size: 13 }, textColor: '#4879AF', maxLines: 1 },
          ],
        },
      ],
    });
    if (i < 5) fc.push({ type: 'spacer' });
  }

  return {
    type: 'widget',
    padding: 14,
    backgroundColor: { light: '#FCFDFF', dark: '#1B2A42' },
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children: [
      header,
      { type: 'spacer', length: 6 },
      hero,
      { type: 'spacer', length: 8 },
      row1,
      { type: 'spacer', length: 4 },
      row2,
      { type: 'spacer' },
      { type: 'stack', direction: 'row', alignItems: 'center', children: fc },
    ],
  };
}

function renderSmall(m) {
  const T = { light: '#16324A', dark: '#F2F7FC' };
  const S = { light: '#607287', dark: '#A9B9CD' };
  const BLUE = { light: '#257CC5', dark: '#78B8FF' };
  return {
    type: 'widget',
    padding: 12,
    backgroundColor: { light: '#FCFDFF', dark: '#1B2A42' },
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center',
        children: [
          { type: 'image', src: 'sf-symbol:location.fill', width: 12, height: 12, color: BLUE },
          { type: 'spacer', length: 3 },
          { type: 'text', text: m.place, font: { size: 13, weight: 'semibold' }, textColor: BLUE, maxLines: 1 },
        ],
      },
      { type: 'spacer' },
      {
        type: 'stack', direction: 'row', alignItems: 'center',
        children: [
          { type: 'text', text: `${m.temp || '--'}°`, font: { size: 42, weight: 'bold' }, textColor: T, maxLines: 1 },
          { type: 'spacer', length: 8 },
          { type: 'text', text: weatherEmoji(m.icon), font: { size: 32 }, maxLines: 1 },
        ],
      },
      { type: 'text', text: m.text || '', font: { size: 13, weight: 'medium' }, textColor: T, maxLines: 1 },
      { type: 'spacer' },
      {
        type: 'stack', direction: 'row', gap: 8,
        children: [
          { type: 'text', text: m.daily[0] ? `高 ${m.daily[0].tempMax}°` : '', font: { size: 12 }, textColor: '#D85D3F', maxLines: 1 },
          { type: 'text', text: m.daily[0] ? `低 ${m.daily[0].tempMin}°` : '', font: { size: 12 }, textColor: '#4879AF', maxLines: 1 },
        ],
      },
    ],
  };
}

async function main(ctx) {
  const env = ctx.env || {};
  const key = (env.QWEATHER_KEY || '').trim();
  const location = (env.QWEATHER_LOCATION || '合肥').trim() || '合肥';

  if (!key) {
    return {
      type: 'widget',
      padding: 16,
      children: [
        { type: 'text', text: '和风天气·晴雨', font: { size: 14, weight: 'semibold' }, textColor: '#257CC5' },
        { type: 'spacer', length: 8 },
        { type: 'text', text: '请在模块设置里填写和风天气 API Key', font: { size: 13 }, textColor: '#607287' },
      ],
    };
  }

  try {
    const m = await getWeatherData(ctx, location, key);
    const family = ctx.widgetFamily || 'medium';
    if (family === 'small') return renderSmall(m);
    return renderMedium(m);
  } catch (e) {
    return {
      type: 'widget',
      padding: 16,
      children: [
        { type: 'text', text: '天气暂不可用', font: { size: 16, weight: 'bold' }, textColor: '#16324A' },
        { type: 'spacer', length: 4 },
        { type: 'text', text: String(e.message || e), font: { size: 12 }, textColor: '#607287' },
      ],
    };
  }
}

// Egern 入口
if (typeof $ !== 'undefined' && $.env) {
  // Egern 环境
  module.exports = { main };
} else if (typeof ctx !== 'undefined') {
  main(ctx).then(r => $done(r)).catch(e => $done({ type: 'widget', padding: 16, children: [{ type: 'text', text: String(e.message || e) }] }));
}
