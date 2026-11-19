import { createSource } from './source.mjs';
import { createService } from './src/service.mjs';

const port = Number(process.env.PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 应为 1 到 65535 之间的整数');
}
const servicePort = Number(process.env.SERVICE_PORT ?? (port + 100));
if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) {
  throw new Error('SERVICE_PORT 应为 1 到 65535 之间的整数');
}
const source = createSource();
source.listen(port, '127.0.0.1', () => {
  console.log('演练来源已启动 http://127.0.0.1:' + port);
});
const service = createService({ sourceUrl: 'http://127.0.0.1:' + port });
service.server.listen(servicePort, '127.0.0.1', () => {
  console.log('换装资料交换服务已启动 http://127.0.0.1:' + servicePort);
});

