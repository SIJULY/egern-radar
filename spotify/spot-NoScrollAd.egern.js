export default async function(ctx) {
// get the binary response body
let body = new Uint8Array(await ctx.response.arrayBuffer());

let MAX=666;
let flag=0;
console.log(`ScrollNoAd`);
for (let i = 0; i < MAX; i++) {
    if (body[i] === 0xF2 && body[i + 1] === 0x01) {

        body[i] = 0xF7;
        body[i + 1] = 0x07;
        console.log(`Changed tag value at offset ${i}`);
        flag=1;
        return { body };
        return;
    }
}

if(!flag) console.log(`No ads detected`);
return {};
}
