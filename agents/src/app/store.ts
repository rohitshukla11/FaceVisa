import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
type Hex = `0x${string}`;

/** Rendered files on local disk (gitignored `renders/`), keyed by their sha256. */
export class RenderStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private paths(hash: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("bad hash");
    const base = join(this.dir, hash.toLowerCase());
    return { file: `${base}.bin`, meta: `${base}.json` };
  }

  save(hash: Hex, bytes: Uint8Array, meta: { mime: string; licenceId: string; renderIndex: number }) {
    const p = this.paths(hash);
    writeFileSync(p.file, bytes);
    writeFileSync(p.meta, JSON.stringify(meta));
  }

  /** A video's poster frame (JPEG), shown in galleries before the video is loaded. */
  savePoster(hash: Hex, jpeg: Uint8Array) {
    writeFileSync(`${this.paths(hash).file.slice(0, -4)}.poster.jpg`, jpeg);
  }

  readPoster(hash: Hex): Buffer | undefined {
    const p = `${this.paths(hash).file.slice(0, -4)}.poster.jpg`;
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  /** Every stored render with its metadata, size and time (for records made before render records existed). */
  list(): { hash: Hex; mime: string; licenceId: string; renderIndex: number; size: number; mtime: number }[] {
    return readdirSync(this.dir)
      .filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f))
      .flatMap((f) => {
        const hash = f.slice(0, -5) as Hex;
        const bin = join(this.dir, `${hash}.bin`);
        if (!existsSync(bin)) return [];
        const meta = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as { mime: string; licenceId: string; renderIndex: number };
        const st = statSync(bin);
        return [{ hash, mime: meta.mime, licenceId: meta.licenceId, renderIndex: meta.renderIndex, size: st.size, mtime: st.mtimeMs }];
      });
  }

  /** Bytes on disk: files and posters. */
  totalBytes(): number {
    return readdirSync(this.dir).reduce((n, f) => n + statSync(join(this.dir, f)).size, 0);
  }

  /** Deletes a render's file and poster (the public demo's 48-hour rule); its metadata stays, so it reads as gone. */
  remove(hash: Hex) {
    const p = this.paths(hash);
    for (const f of [p.file, `${p.file.slice(0, -4)}.poster.jpg`]) if (existsSync(f)) rmSync(f);
  }

  read(hash: Hex): { bytes: Buffer; mime: string } | undefined {
    const p = this.paths(hash);
    if (!existsSync(p.file)) return undefined;
    const meta = JSON.parse(readFileSync(p.meta, "utf8")) as { mime: string };
    return { bytes: readFileSync(p.file), mime: meta.mime };
  }
}
