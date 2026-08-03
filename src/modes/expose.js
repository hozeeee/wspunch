'use strict';

/**
 * expose 模式 —— 跑在真正能访问目标服务的那台机器上。
 *
 * 干两件事：
 *   1. 用 --expose 声明自己愿意暴露哪些服务（`名字=host:port`），WS 一接上就把
 *      这份清单下发给对端；
 *   2. 收到对端按名字发来的建流请求后，连到对应目标，然后在这条 TCP 连接和 WS
 *      之间双向搬运数据。
 *
 * 清单就是白名单：名字不在里面的建流请求一律拒掉，对端点不到没声明的地址。
 *
 * 接法与角色无关：给 --port 就自己起服务等对端来接，给 --url 就主动去接对端。
 */

const net = require('node:net');
const { once } = require('node:events');

const { startLink } = require('../lib/link');
const { Tunnel } = require('../lib/tunnel');
const { createLogger } = require('../lib/util');

/** 连到目标地址，带超时；成功返回 socket。 */
async function connectTarget(host, port, timeoutMs) {
  const socket = net.connect({ host, port, allowHalfOpen: true });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`连接 ${host}:${port} 超时`)));
  await once(socket, 'connect');
  socket.setTimeout(0); // 连上之后不再限制空闲时间
  return socket;
}

function run(opts) {
  const log = createLogger('expose', opts.verbose);
  if (!opts.token) log.warn('未设置 --token，任何人都能接上来用这些服务，仅建议在本地实验时这样用');

  const table = new Map(opts.services.map((s) => [s.name, s]));
  const catalog = opts.services.map((s) => ({ name: s.name, target: s.target }));

  for (const s of opts.services) log.info(`已声明服务：${s.name}  ==>  ${s.target}`);

  startLink({
    opts,
    log,
    onPeer: (ws, label) => {
      const tunnel = new Tunnel(ws, {
        log,
        onOpen: async (name) => {
          const svc = table.get(name);
          if (!svc) throw new Error(`本端没有声明名为 "${name}" 的服务`);
          const socket = await connectTarget(svc.host, svc.port, opts.connectTimeout);
          return { socket, label: `${svc.name} -> ${svc.target}` };
        },
      });
      // 对端要先知道有哪些服务才能建流，所以一接上就下发清单
      tunnel.sendServices(catalog);
      log.info(`已向 ${label} 下发服务清单：${catalog.map((s) => s.name).join('、') || '（空）'}`);
      return tunnel;
    },
  });
}

module.exports = { run };
