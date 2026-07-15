/**
 * Core API request helpers for MiniMax Agent API
 * Adapted for Cloudflare Workers runtime (fetch-based, no Node.js deps)
 */
import { md5, uuid, unixTimestamp, timestamp } from './util';

const AGENT_BASE_URL = 'https://agent.minimaxi.com';
const DEVICE_INFO_EXPIRES = 10800;
const FILE_MAX_SIZE = 100 * 1024 * 1024;

const FAKE_HEADERS: Record<string, string> = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  'Origin': 'https://agent.minimaxi.com',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
};

interface FakeUserData {
  device_platform: string;
  biz_id: string;
  app_id: string;
  version_code: string;
  uuid: string | null;
  device_id: string | null;
  os_name: string;
  browser_name: string;
  device_memory: number;
  cpu_core_num: number;
  browser_language: string;
  browser_platform: string;
  user_id: string | null;
  screen_width: number;
  screen_height: number;
  unix: string | null;
  lang: string;
  token: string | null;
}

function makeUserData(): FakeUserData {
  return {
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    uuid: null,
    device_id: null,
    os_name: 'Mac',
    browser_name: 'chrome',
    device_memory: 8,
    cpu_core_num: 11,
    browser_language: 'zh-CN',
    browser_platform: 'MacIntel',
    user_id: null,
    screen_width: 1920,
    screen_height: 1080,
    unix: null,
    lang: 'zh',
    token: null,
  };
}

// Device info cache
const deviceInfoMap = new Map<string, DeviceInfo>();
const deviceInfoRequestQueueMap: Record<string, Array<(v: DeviceInfo | Error) => void>> = {};

export interface DeviceInfo {
  deviceId: string;
  userId: string;
  realUserID: string;
  refreshTime: number;
}

export interface UploadedFile {
  fileType: number;
  filename: string;
  fileId: string;
}

/**
 * Parse token from "realUserID+jwtToken" format
 */
export function parseToken(token: string): { realUserID: string; jwtToken: string; deviceInfo: DeviceInfo } {
  let realUserID: string;
  let jwtToken: string;

  const plusIndex = token.indexOf('+');
  if (plusIndex !== -1) {
    realUserID = token.substring(0, plusIndex);
    jwtToken = token.substring(plusIndex + 1);
    if (!realUserID || !jwtToken) {
      throw new Error('Token format error: realUserID and token cannot be empty');
    }
  } else {
    jwtToken = token;
    const jwtParts = jwtToken.split('.');
    if (jwtParts.length !== 3) {
      throw new Error('Token format error: invalid JWT');
    }
    try {
      const payload = JSON.parse(atob(jwtParts[1]));
      realUserID = payload.user?.id;
      if (!realUserID) throw new Error('Missing user ID in token');
    } catch (e: any) {
      throw new Error(`Token parse failed: ${e.message}`);
    }
  }

  // Extract userId and deviceId from JWT
  const jwtParts = jwtToken.split('.');
  let jwtUserId: string;
  let deviceId: number;
  try {
    const payload = JSON.parse(atob(jwtParts[1]));
    jwtUserId = payload.user?.id || '450394515982692354';
    deviceId = payload.user?.deviceID || Math.floor(Math.random() * 100000000);
  } catch {
    jwtUserId = '450394515982692354';
    deviceId = Math.floor(Math.random() * 100000000);
  }

  return {
    realUserID,
    jwtToken,
    deviceInfo: {
      userId: jwtUserId,
      realUserID,
      deviceId: String(deviceId),
      refreshTime: unixTimestamp() + DEVICE_INFO_EXPIRES,
    },
  };
}

/**
 * Token splitting for multi-token support (comma-separated)
 */
export function tokenSplit(authorization: string): string[] {
  const token = authorization.replace('Bearer ', '');
  return token.includes(',') ? token.split(',').map(t => t.trim()) : [token];
}

/**
 * Build query string from user data
 */
function buildQueryString(userData: FakeUserData): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(userData)) {
    if (val === null || val === undefined) continue;
    parts.push(`${key}=${encodeURIComponent(String(val))}`);
  }
  return parts.join('&');
}

/**
 * Acquire device info (cached, with refresh)
 */
export async function acquireDeviceInfo(token: string): Promise<DeviceInfo> {
  const { realUserID, jwtToken } = parseToken(token);

  let cached = deviceInfoMap.get(token);
  if (!cached || unixTimestamp() > cached.refreshTime) {
    cached = await requestDeviceInfo(realUserID, jwtToken);
    deviceInfoMap.set(token, cached);
  }
  return cached;
}

async function requestDeviceInfo(realUserID: string, jwtToken: string): Promise<DeviceInfo> {
  const deviceId = uuid().replace(/-/g, '');

  const result = await request(
    'POST',
    '/v1/api/user/device/register',
    { uuid: deviceId },
    jwtToken,
    { userId: realUserID, deviceId: '', realUserID, refreshTime: 0 },
    { params: {} }
  );

  const data = result as any;
  const deviceIDStr = data?.deviceIDStr || '';

  return {
    deviceId: deviceIDStr,
    userId: realUserID,
    realUserID,
    refreshTime: unixTimestamp() + DEVICE_INFO_EXPIRES,
  };
}

/**
 * HTTP request to MiniMax Agent API
 */
export async function request(
  method: string,
  uri: string,
  reqData: any,
  token: string,
  deviceInfo: DeviceInfo,
  options: { headers?: Record<string, string>; params?: Record<string, any> } = {}
): Promise<any> {
  const unix = `${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  const userData = makeUserData();

  userData.uuid = deviceInfo.realUserID || deviceInfo.userId || null;
  userData.device_id = deviceInfo.deviceId || null;
  userData.user_id = deviceInfo.realUserID || deviceInfo.userId || null;
  userData.unix = unix;
  userData.token = token;

  // Add extra params
  if (options.params) {
    Object.assign(userData, options.params);
  }

  const queryStr = buildQueryString(userData);
  const dataJson = JSON.stringify(reqData || {});
  const fullUri = `${uri}${uri.includes('?') ? '&' : '?'}${queryStr}`;
  const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`);
  const signature = md5(`${ts}${token}${dataJson}`);

  const url = `${AGENT_BASE_URL}${fullUri}`;
  const headers: Record<string, string> = {
    ...FAKE_HEADERS,
    'Referer': 'https://agent.minimaxi.com/',
    'Content-Type': 'application/json',
    'token': token,
    'x-timestamp': `${ts}`,
    'x-signature': signature,
    'yy': yy,
    ...(options.headers || {}),
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : dataJson,
    redirect: 'follow',
  });

  const respData = await resp.json();
  return { status: resp.status, statusText: resp.statusText, data: respData, headers: resp.headers };
}

/**
 * Upload a file (by URL) to MiniMax's OSS
 */
export async function uploadFile(fileUrl: string, token: string): Promise<UploadedFile> {
  const { jwtToken } = parseToken(token);
  const deviceInfo = await acquireDeviceInfo(token);

  // Validate and download file
  let fileData: ArrayBuffer;
  let filename: string;
  let mimeType: string;

  if (fileUrl.startsWith('data:')) {
    // Base64 data
    const match = fileUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid base64 data URL');
    mimeType = match[1];
    const ext = mimeType.split('/')[1] || 'bin';
    filename = `${uuid()}.${ext}`;
    const base64 = match[2];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    fileData = bytes.buffer;
  } else {
    // Remote URL
    const headResp = await fetch(fileUrl, { method: 'HEAD' });
    const contentLength = headResp.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > FILE_MAX_SIZE) {
      throw new Error(`File exceeds max size: ${contentLength}`);
    }
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error(`Failed to download file: ${fileResp.status}`);
    fileData = await fileResp.arrayBuffer();
    const urlPath = new URL(fileUrl).pathname;
    filename = `${uuid()}${urlPath.substring(urlPath.lastIndexOf('.')) || '.bin'}`;
    mimeType = fileResp.headers.get('content-type') || 'application/octet-stream';
  }

  // Get upload policy
  const policyResult = await request(
    'GET',
    '/v1/api/files/request_policy',
    {},
    jwtToken,
    deviceInfo
  );
  const policyData = policyResult.data || policyResult;
  const { accessKeyId, accessKeySecret, bucketName, dir, endpoint, securityToken } = policyData;
  if (!accessKeyId) throw new Error('Failed to get upload policy');

  // Upload to OSS using PUT
  const ossKey = `${dir}/${filename}`;
  const ossUrl = `https://${bucketName}.${endpoint}/${ossKey}`;

  const ossResp = await fetch(ossUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'x-oss-security-token': securityToken || '',
      'Authorization': `OSS ${accessKeyId}:${accessKeySecret}`,
    },
    body: fileData,
  });

  if (!ossResp.ok) {
    throw new Error(`OSS upload failed: ${ossResp.status}`);
  }

  // Callback
  const callbackResult = await request(
    'POST',
    '/v1/api/files/policy_callback',
    {
      fileName: filename,
      originFileName: filename,
      dir,
      endpoint,
      bucketName,
      size: `${fileData.byteLength}`,
      mimeType,
    },
    jwtToken,
    deviceInfo
  );
  const cbData = callbackResult.data || callbackResult;
  const fileID = cbData.fileID || cbData.file_id;

  const isImage = [
    'image/jpeg', 'image/jpg', 'image/tiff', 'image/png', 'image/bmp',
    'image/gif', 'image/svg+xml', 'image/webp', 'image/ico',
    'image/heic', 'image/heif', 'image/x-icon', 'image/vnd.microsoft.icon',
  ].includes(mimeType);

  return {
    fileType: isImage ? 2 : 6,
    filename,
    fileId: fileID,
  };
}

/**
 * Check token liveness
 */
export async function getTokenLiveStatus(token: string): Promise<boolean> {
  try {
    const deviceInfo = await acquireDeviceInfo(token);
    const result = await request('GET', '/v1/api/user/info', {}, token, deviceInfo);
    const data = result.data || result;
    const userInfo = data?.userInfo;
    return !!userInfo && typeof userInfo === 'object';
  } catch {
    deviceInfoMap.delete(token);
    return false;
  }
}
