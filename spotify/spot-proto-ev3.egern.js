// Egern 适配器：运行上游 Loon 版 spot-proto-ev3.js（protobuf 本地补丁，解锁高级功能）
// 上游脚本 380KB+，走 GitHub 接口写入超限；这里在运行时 shim Loon 全局量后加载执行。
// 上游版本 pin 到 commit 7ae0a25（2026-10-08，与 lpx 同期）；想跟上游更新改 SCRIPT_URL 即可。
export default async function(ctx) {
  const SCRIPT_URL = 'https://raw.githubusercontent.com/devchristian1337/loon-plugins/7ae0a25b2de75746dc602bfa890b9737d3847a9f/Scripts/Spotify/spot-proto-ev3.js';

  let code;
  try {
    code = await (await ctx.http.get(SCRIPT_URL, { timeout: 15000 })).text();
  } catch (e) {
    console.log(`Spotify proto-ev3: 上游脚本加载失败 (${e})，本次放行`);
    return {};
  }

  const bodyBytes = new Uint8Array(await ctx.response.arrayBuffer());
  const $request = { url: ctx.request.url, method: ctx.request.method };
  const $response = { status: ctx.response.status, statusCode: ctx.response.status, body: bodyBytes };
  let _out;
  const $done = (v) => { _out = v || {}; };
  const $notification = {
    post: (title, subtitle, body) =>
      ctx.notify({ title: String(title), body: [subtitle, body].filter(Boolean).join(' ') }),
  };

  // $task 不注入 -> 上游的 typeof $task === 'undefined' -> 走非 QuanX 分支（$response.body）
  new Function('$request', '$response', '$done', '$notification', 'console', code)(
    $request, $response, $done, $notification, console
  );

  if (_out && _out.body) return { body: _out.body };
  if (_out && _out.bodyBytes) return { body: new Uint8Array(_out.bodyBytes) };
  return {};
}
