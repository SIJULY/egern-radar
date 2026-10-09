export default async function(ctx) {
  // 对应 lpx 里的 reject-dict：返回 200 空 JSON
  return ctx.respond({ status: 200, headers: { 'Content-Type': 'application/json' }, body: {} });
}
