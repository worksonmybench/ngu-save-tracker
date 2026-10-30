import SparkMD5 from 'spark-md5';
import { Reader } from './nrbf';

export const MAX_SAVE_BYTES = 64 * 1024 * 1024;

export type PlayerData = Record<string, any>;
export type DecodedSave = { player: PlayerData; checksum: string };

function fromBase64(text: string) {
  const bin = atob(text.replace(/[\s﻿]+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// save text = base64(NRBF(SaveData{playerData, checksum})), playerData = base64(NRBF(PlayerData)),
// checksum = base64(MD5(raw playerData)). See SAVE_FORMAT.md.
export function decodeSave(text: string): DecodedSave {
  if (text.length > MAX_SAVE_BYTES) throw new Error('file is too large to be a save');
  let outer: any;
  try {
    outer = new Reader(fromBase64(text)).parse();
  } catch (e) {
    throw new Error(`not an NGU Idle save (${(e as Error).message})`);
  }
  if (typeof outer?.playerData !== 'string' || typeof outer?.checksum !== 'string') {
    throw new Error('not an NGU Idle save (missing playerData)');
  }
  const inner = fromBase64(outer.playerData);
  const raw = inner.buffer.slice(inner.byteOffset, inner.byteOffset + inner.byteLength) as ArrayBuffer;
  if (btoa(SparkMD5.ArrayBuffer.hash(raw, true)) !== outer.checksum) {
    throw new Error('checksum mismatch: the save is damaged or was edited');
  }
  const player = new Reader(inner).parse() as PlayerData;
  if (typeof player !== 'object' || player === null) throw new Error('save has no player data');
  return { player, checksum: outer.checksum };
}
