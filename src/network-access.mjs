import { isIP } from 'node:net';

function ipv4Value(input) {
  const parts = input.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(`Некорректный IPv4-адрес: ${input}`);
  }
  return parts.reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv6Value(input) {
  let source = input.toLowerCase().split('%')[0];
  if (source.includes('.')) {
    const separator = source.lastIndexOf(':');
    if (separator < 0) throw new Error(`Некорректный IPv6-адрес: ${input}`);
    const ipv4 = ipv4Value(source.slice(separator + 1));
    source = `${source.slice(0, separator)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  if ((source.match(/::/g) || []).length > 1) throw new Error(`Некорректный IPv6-адрес: ${input}`);
  const [leftRaw, rightRaw] = source.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw === undefined || rightRaw === '' ? [] : rightRaw.split(':');
  const missing = 8 - left.length - right.length;
  if (rightRaw === undefined ? missing !== 0 : missing < 1) throw new Error(`Некорректный IPv6-адрес: ${input}`);
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
    throw new Error(`Некорректный IPv6-адрес: ${input}`);
  }
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function formatAddress(value, version) {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
  }
  return [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n]
    .map(shift => ((value >> shift) & 0xffffn).toString(16)).join(':');
}

export function parseCidr(value) {
  const input = String(value || '').trim();
  const slash = input.indexOf('/');
  const address = slash < 0 ? input : input.slice(0, slash);
  const version = isIP(address.split('%')[0]);
  if (!version) throw new Error(`Некорректная подсеть: ${input}`);
  const bits = version === 4 ? 32 : 128;
  const prefixText = slash < 0 ? String(bits) : input.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) throw new Error(`Некорректный префикс CIDR: ${input}`);
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > bits) throw new Error(`Префикс CIDR вне диапазона: ${input}`);
  const addressValue = version === 4 ? ipv4Value(address) : ipv6Value(address);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  const network = addressValue & mask;
  return { version, prefix, network, normalized: `${formatAddress(network, version)}/${prefix}` };
}

export function normalizeAllowedSubnets(value) {
  if (!Array.isArray(value)) throw new Error('Список разрешённых подсетей должен быть массивом');
  if (!value.length) throw new Error('Нужно оставить хотя бы одну разрешённую подсеть');
  if (value.length > 64) throw new Error('Разрешено не более 64 подсетей');
  const normalized = value.map(item => parseCidr(item).normalized);
  return [...new Set(normalized)];
}

export function ipInSubnets(ip, subnets) {
  let cleanIp = String(ip || '').split('%')[0];
  const mappedIpv4 = cleanIp.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mappedIpv4) cleanIp = mappedIpv4[1];
  const version = isIP(cleanIp);
  if (!version) return false;
  let addressValue;
  try {
    addressValue = version === 4 ? ipv4Value(cleanIp) : ipv6Value(cleanIp);
  } catch {
    return false;
  }
  return subnets.some(item => {
    try {
      const cidr = parseCidr(item);
      if (cidr.version !== version) return false;
      const bits = version === 4 ? 32 : 128;
      const mask = cidr.prefix === 0 ? 0n : ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(bits - cidr.prefix);
      return (addressValue & mask) === cidr.network;
    } catch {
      return false;
    }
  });
}
