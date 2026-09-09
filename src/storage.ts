import { Buffer } from "node:buffer";

const CHUNK_BYTES = 512 * 1024;
const PREFIX = "@fiend/blob/";

/** SQLite rows are limited to 2 MB. Documents and exports span bounded rows. */
export class SceneStorage {
  constructor(private sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS scene_blobs (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))");
  }

  write(data: Uint8Array): string {
    const id = crypto.randomUUID();
    for (let offset = 0, part = 0; offset < data.byteLength; offset += CHUNK_BYTES, part++) {
      this.sql.exec("INSERT INTO scene_blobs (id, part, data) VALUES (?, ?, ?)", id, part, data.subarray(offset, offset + CHUNK_BYTES));
    }
    return id;
  }

  read(id: string) {
    const chunks = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM scene_blobs WHERE id = ? ORDER BY part", id).toArray();
    if (!chunks.length) throw new Error("Stored scene data is missing");
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data)));
  }

  encode(value: unknown): string {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) <= CHUNK_BYTES) return json;
    const id = crypto.randomUUID();
    for (let offset = 0, part = 0; offset < json.length; part++) {
      let end = Math.min(json.length, offset + CHUNK_BYTES / 4);
      const last = json.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff && end < json.length) end--;
      this.sql.exec("INSERT INTO scene_blobs (id, part, data) VALUES (?, ?, ?)", id, part, Buffer.from(json.slice(offset, end)));
      offset = end;
    }
    return `${PREFIX}${id}`;
  }

  decode<T>(value: string): T {
    if (!value.startsWith(PREFIX)) return JSON.parse(value);
    const decoder = new TextDecoder();
    const parts: string[] = [];
    for (const row of this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM scene_blobs WHERE id = ? ORDER BY part", value.slice(PREFIX.length))) {
      parts.push(decoder.decode(row.data, { stream: true }));
    }
    if (!parts.length) throw new Error("Stored scene data is missing");
    parts.push(decoder.decode());
    const json = parts.join("");
    parts.length = 0;
    return JSON.parse(json);
  }

  drop(value: string) {
    if (value.startsWith(PREFIX)) this.sql.exec("DELETE FROM scene_blobs WHERE id = ?", value.slice(PREFIX.length));
  }
}
