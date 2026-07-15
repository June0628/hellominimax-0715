import { md5 } from './md5';

export function uuid(): string {
  return crypto.randomUUID();
}

export function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function timestamp(): number {
  return Date.now();
}

export { md5 };
