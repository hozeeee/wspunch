'use strict';

const { EventEmitter } = require('node:events');
const { TYPE, encode, decode, typeName } = require('./protocol');
const { formatBytes } = require('./util');

const WS_OPEN = 1;

// WS 发送缓冲的高/低水位：超过高水位就暂停所有 TCP 源，降到低水位再恢复，
// 避免下游慢、上游猛灌时把内存吃光。
const WS_HIGH_WATER = 1024 * 1024;
const WS_LOW_WATER = 256 * 1024;
const DRAIN_POLL_MS = 20;

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 挂在一条 WebSocket 上的流复用器，两种模式共用同一份实现。
 *
 * - 发起方（access 端）调用 open(socket, service) 按服务名建流；
 * - 响应方（expose 端）通过 onOpen(service) 回调把服务名解成真实目标并 connect，
 *   返回 { socket, label }（label 仅用于日志）；
 * - expose 端另用 sendServices() 下发服务清单，access 端收到后 emit 'services'。
 *
 * 内部负责：TCP <-> 帧 的双向搬运、半关闭语义、双向背压、流清理。
 */
class Tunnel extends EventEmitter {
  constructor(ws, { log = NOOP_LOG, onOpen = null } = {}) {
    super();
    this.ws = ws;
    this.log = log;
    this.onOpen = onOpen;
    this.streams = new Map();
    this._nextId = 1;
    this._drainTimer = null;
    this._destroyed = false;

    ws.on('message', (data) => {
      try {
        this._onFrame(toBuffer(data));
      } catch (err) {
        this.log.error(`处理帧出错：${err.message}`);
      }
    });
    ws.once('close', () => this.destroy(new Error('WS 通道已关闭')));
    ws.on('error', (err) => this.destroy(err));
  }

  get streamCount() {
    return this.streams.size;
  }

  // ---------------------------------------------------------------- 发起方 API

  /** 把一条已建立的本地 TCP 连接接入隧道，请对端连到名为 service 的服务。 */
  open(socket, service) {
    const streamId = this._allocId();
    const st = this._createStream(streamId, service);
    this._send(TYPE.OPEN, streamId, service);
    this._attachSocket(st, socket);
    return streamId;
  }

  /** 响应方 API：把自己能提供的服务清单告诉对端。 */
  sendServices(list) {
    return this._send(TYPE.SERVICES, 0, JSON.stringify(list));
  }

  _allocId() {
    let id = this._nextId;
    while (id === 0 || this.streams.has(id)) id = (id % 0xffffffff) + 1;
    this._nextId = (id % 0xffffffff) + 1;
    return id;
  }

  // ------------------------------------------------------------------ 帧处理

  _onFrame(buf) {
    const frame = decode(buf);
    if (!frame) {
      this.log.warn('丢弃一个无法解析的帧');
      return;
    }
    const { type, streamId, payload } = frame;
    const st = this.streams.get(streamId);

    if (type === TYPE.OPEN) {
      this._onOpenFrame(streamId, payload.toString('utf8'));
      return;
    }
    if (type === TYPE.SERVICES) {
      this._onServicesFrame(payload);
      return;
    }
    if (!st) {
      // 流已在本端清理掉（常见于双方几乎同时关闭），静默忽略即可。
      this.log.debug(`忽略已关闭流 #${streamId} 的 ${typeName(type)} 帧`);
      return;
    }

    switch (type) {
      case TYPE.DATA:
        st.bytesIn += payload.length;
        this._writeToSocket(st, payload);
        break;

      case TYPE.END:
        st.peerEnded = true;
        if (st.socket) st.socket.end();
        else st.endAfterConnect = true;
        this._maybeCleanup(st);
        break;

      case TYPE.RESET: {
        const reason = payload.length ? payload.toString('utf8') : '对端重置';
        this.log.debug(`流 #${streamId} 被对端重置：${reason}`);
        st.resetByPeer = true;
        this._closeStream(st, reason);
        break;
      }

      case TYPE.PAUSE:
        st.pausedByPeer = true;
        this._applyFlow(st);
        break;

      case TYPE.RESUME:
        st.pausedByPeer = false;
        this._applyFlow(st);
        break;
    }
  }

  _onOpenFrame(streamId, service) {
    if (typeof this.onOpen !== 'function') {
      this._send(TYPE.RESET, streamId, '本端不接受建流请求');
      return;
    }
    if (this.streams.has(streamId)) {
      this._send(TYPE.RESET, streamId, `流 #${streamId} 已存在`);
      return;
    }
    const st = this._createStream(streamId, service);
    this.log.debug(`收到建流请求 #${streamId} -> ${service}`);

    Promise.resolve()
      .then(() => this.onOpen(service, st))
      .then(({ socket, label }) => {
        if (label) st.target = label;
        if (st.closed) {
          socket.destroy();
          return;
        }
        this._attachSocket(st, socket);
        this.log.info(`流 #${streamId} 已连通 ${st.target}`);
      })
      .catch((err) => {
        this.log.warn(`流 #${streamId} 连接服务 ${service} 失败：${err.message}`);
        this._send(TYPE.RESET, streamId, err.message);
        this.streams.delete(streamId);
        st.closed = true;
      });
  }

  _onServicesFrame(payload) {
    let list;
    try {
      list = JSON.parse(payload.toString('utf8'));
    } catch {
      this.log.warn('对端发来的服务清单无法解析');
      return;
    }
    if (!Array.isArray(list)) {
      this.log.warn('对端发来的服务清单不是数组');
      return;
    }
    this.emit(
      'services',
      list.filter((s) => s && typeof s.name === 'string'),
    );
  }

  // -------------------------------------------------------------- 流生命周期

  _createStream(streamId, target) {
    const st = {
      id: streamId,
      target, // 日志用的标签：access 侧是服务名，expose 侧连上后换成 服务名 -> 真实地址
      socket: null,
      pending: [], // socket 就绪前收到的数据
      endAfterConnect: false,
      localEnded: false, // 本端 socket 已 FIN，且已发出 END
      peerEnded: false, // 已收到对端 END
      resetByPeer: false,
      closed: false,
      pausedByPeer: false,
      pausedByWs: false,
      bytesIn: 0, // 从 WS 收到、写进 socket 的字节数
      bytesOut: 0, // 从 socket 读到、发进 WS 的字节数
      startedAt: Date.now(),
    };
    this.streams.set(streamId, st);
    return st;
  }

  _attachSocket(st, socket) {
    st.socket = socket;
    socket.setNoDelay(true);

    socket.on('data', (chunk) => {
      st.bytesOut += chunk.length;
      this._send(TYPE.DATA, st.id, chunk);
      this._checkWsBackpressure(st);
    });

    socket.on('end', () => {
      // 本端 TCP 读到 FIN：告诉对端「我不再发数据了」，但仍可继续接收。
      st.localEnded = true;
      this._send(TYPE.END, st.id);
      this._maybeCleanup(st);
    });

    socket.on('drain', () => {
      // 本端已排空，通知对端可以继续投喂。
      this._send(TYPE.RESUME, st.id);
    });

    socket.on('error', (err) => {
      if (st.closed) return;
      this.log.debug(`流 #${st.id} socket 出错：${err.message}`);
      this._send(TYPE.RESET, st.id, err.message);
      this._closeStream(st, err.message);
    });

    socket.on('close', () => {
      if (st.closed) return;
      // 双方都正常 FIN 过 -> 属于正常收尾；否则视为异常中断。
      if (!(st.localEnded && st.peerEnded)) this._send(TYPE.RESET, st.id, 'socket 已关闭');
      this._closeStream(st, 'socket 已关闭');
    });

    // 补发 socket 就绪前积压的数据与 FIN
    for (const chunk of st.pending) this._writeToSocket(st, chunk);
    st.pending.length = 0;
    if (st.endAfterConnect) {
      st.endAfterConnect = false;
      socket.end();
    }
    this._applyFlow(st);
  }

  _writeToSocket(st, chunk) {
    if (!st.socket) {
      st.pending.push(chunk);
      return;
    }
    if (st.socket.writableEnded || st.closed) return;
    const ok = st.socket.write(chunk);
    // 写不下了：反压给对端，让它暂停从自己的 socket 读数据。
    if (!ok) this._send(TYPE.PAUSE, st.id);
  }

  /** WS 发送缓冲积压过多时，暂停所有源 socket，等排空后统一恢复。 */
  _checkWsBackpressure(st) {
    if (this.ws.bufferedAmount <= WS_HIGH_WATER) return;
    if (!st.pausedByWs) {
      st.pausedByWs = true;
      this._applyFlow(st);
    }
    if (this._drainTimer) return;
    this._drainTimer = setInterval(() => {
      if (this._destroyed || this.ws.bufferedAmount <= WS_LOW_WATER) {
        clearInterval(this._drainTimer);
        this._drainTimer = null;
        for (const s of this.streams.values()) {
          if (s.pausedByWs) {
            s.pausedByWs = false;
            this._applyFlow(s);
          }
        }
      }
    }, DRAIN_POLL_MS);
    this._drainTimer.unref();
  }

  /** 两种暂停原因（对端慢 / WS 缓冲满）取并集，都解除才恢复读取。 */
  _applyFlow(st) {
    if (!st.socket || st.closed) return;
    if (st.pausedByPeer || st.pausedByWs) st.socket.pause();
    else st.socket.resume();
  }

  /** 双向都已 FIN，可以收尾了。 */
  _maybeCleanup(st) {
    if (st.localEnded && st.peerEnded) this._closeStream(st, '正常结束');
  }

  _closeStream(st, reason) {
    if (st.closed) return;
    st.closed = true;
    this.streams.delete(st.id);
    if (st.socket) {
      st.socket.removeAllListeners('data');
      st.socket.removeAllListeners('drain');
      if (st.resetByPeer) st.socket.destroy();
      else st.socket.end();
      // 兜底：对方赖着不关就强杀
      const timer = setTimeout(() => st.socket.destroy(), 5000);
      timer.unref();
      st.socket.once('close', () => clearTimeout(timer));
    }
    const ms = Date.now() - st.startedAt;
    this.log.info(
      `流 #${st.id} 关闭（${st.target}，上行 ${formatBytes(st.bytesOut)} / 下行 ${formatBytes(st.bytesIn)}，${ms}ms，${reason}）`,
    );
    this.emit('streamClose', st);
  }

  _send(type, streamId, payload) {
    if (this._destroyed || this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(encode(type, streamId, payload));
    return true;
  }

  /** WS 断开或主动收摊：把所有流一并关掉。 */
  destroy(err) {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._drainTimer) {
      clearInterval(this._drainTimer);
      this._drainTimer = null;
    }
    const reason = err ? err.message : '隧道关闭';
    for (const st of [...this.streams.values()]) {
      st.resetByPeer = true; // WS 已断，无法再优雅收尾，直接断开本地连接
      this._closeStream(st, reason);
    }
    this.emit('close', err);
  }
}

module.exports = { Tunnel };
