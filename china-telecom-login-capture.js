/*
 * 中国电信登录地址捕获（Egern request 脚本，一次性使用）
 *
 * 作用：在 Safari/浏览器里登录 e.dlife.cn 成功的那一刻，自动捕获登录地址，
 * 写入存储并弹通知，点击通知即可复制地址。
 *
 * 安装：Egern → 工具 → 脚本 → + → 名称填「电信登录捕获」→ 类型选 Request →
 *       脚本 URL 填本文件的 raw 链接 → URL 匹配填 e.dlife.cn → 保存并启用。
 * 捕获成功后可停用或删除本脚本（不影响小组件）。
 */

export default async function (ctx) {
  const url = (ctx.request && ctx.request.url) || '';
  // 只处理电信网厅的登录请求，其余一律透传（不返回值 = 不修改请求）
  if (!url.includes('e.dlife.cn/user/loginMiddle')) return;

  const loginUrl = (url.match(/(http.+)&sign/) || [])[1] || url;
  if (!loginUrl) return;

  const prev = ctx.storage.get('ct_login_url');
  if (prev === loginUrl) return; // 已捕获过，不重复打扰

  ctx.storage.set('ct_login_url', loginUrl);
  ctx.notify({
    title: '中国电信',
    body: '登录地址已捕获，点击复制，然后填入小组件的 CT_LOGIN_URL',
    action: { type: 'clipboard', text: loginUrl },
  });
}
