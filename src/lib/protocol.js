'use strict';

/**
 * WS 信道上的二进制帧协议。
 *
 * WebSocket 本身保留消息边界，所以不需要额外的长度前缀，
 * 一个 WS 消息 == 一个帧：
 *
 *   +--------+------------------+------------------+
 *   | type   | streamId         | payload          |
 *   | 1 byte | 4 bytes (BE)     | 变长             |
 *   +--------+------------------+------------------+
 *
 * streamId 由发起方（access 端）分配，一条 TCP 连接对应一个 streamId，
 * 因此单条 WS 连接可以同时承载任意多条 TCP 流。
 *
 * 谁监听谁拨号与协议无关：WS 建起来之后，永远是 expose 端先下发服务清单，
 * access 端再按服务名建流。
 */

const TYPE = {
  OPEN: 0x01, // access -> expose  请求建立一条流，payload 为服务名
  DATA: 0x02, // 双向    负载数据
  END: 0x03, // 双向    我这边不再发数据了（对应 TCP 的 FIN，半关闭）
  RESET: 0x04, // 双向    流异常中断，payload 为可选原因文本
  PAUSE: 0x05, // 双向    对端写不下了，请暂停投喂（背压）
  RESUME: 0x06, // 双向    对端已排空，可以继续
  SERVICES: 0x07, // expose -> access  服务清单，streamId 恒为 0，payload 为 JSON 数组
};

const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));

const HEADER_SIZE = 5;

function encode(type, streamId, payload) {
  const body =
    payload == null ? null : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_SIZE + (body ? body.length : 0));
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(streamId, 1);
  if (body) body.copy(frame, HEADER_SIZE);
  return frame;
}

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) return null;
  const type = buf.readUInt8(0);
  if (!TYPE_NAME[type]) return null;
  return { type, streamId: buf.readUInt32BE(1), payload: buf.subarray(HEADER_SIZE) };
}

function typeName(type) {
  return TYPE_NAME[type] || `UNKNOWN(${type})`;
}

module.exports = { TYPE, HEADER_SIZE, encode, decode, typeName };
