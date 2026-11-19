# 冷链转运资料交换服务

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /scanner/events` origin 和 scanId 共同定位一次扫描。事件时间为设备时刻，clockProof 给出修正秒数和误差界。
- `GET /scanner/clocks` 秒差加到设备时刻，误差范围在结果两侧。
- `GET /dock/packing` revision 为装箱动作修订号。units 是实物标签，bay 指触发换装时所在工位。
- `GET /logger/windows` 读数附着于安装段，workingBay 是换装台测点，已覆盖时间为左闭右开。间断不通过插值补齐。
- `POST /receiver/receipts` 交接方接受 requestKey、units、arrival、finding。修订条目带原交接编号。
- `GET /receiver/receipts` 以 requestKey 查询。
