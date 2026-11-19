#!/usr/bin/env node
// 单独启动换装资料交换服务。默认与演练来源通话：先 /collect 拉取三处原始资料，
// 再由收货人按到达批追查。PORT 改服务端口，SOURCE 改演练来源地址。

import { createService } from './src/service.mjs';

const port = Number(process.env.PORT ?? 3200);
const sourceUrl = process.env.SOURCE ?? 'http://127.0.0.1:3100';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 应为 1 到 65535 之间的整数');
}

const service = createService({ sourceUrl });
service.server.listen(port, '127.0.0.1', () => {
  console.log('换装资料交换服务已启动 http://127.0.0.1:' + port);
  console.log('演练来源：' + sourceUrl);
});
