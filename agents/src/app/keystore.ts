/**
 * This app's encrypted keystore: custodial secp256k1 keys, one per account (generated on first need; the same key
 * becomes the account's Hedera ECDSA key later), plus the platform's own: "receipt" (writes receipts on Arkiv) and
 * "funder" (holds tGLM and tops up account keys before their first write).
 *
 * One git-ignored file per mode, keystores/<mode>/keystore.json (mode 600). Each key is sealed with AES-256-GCM under
 * a key derived by scrypt from the password in FACEVISA_KEYSTORE_PASSWORD_FILE, with its name and address as the
 * additional data, so a sealed key can't be moved to another name or address. A sealed check value makes a wrong
 * password fail at open. Private keys leave this module only inside a viem account: never in .env, logs or output.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

type Hex = `0x${string}`;

export type PlatformKey = "receipt" | "funder";

export interface ScryptParams { N: number; r: number; p: number }
interface Sealed { iv: string; ct: string; tag: string }
interface SealedKey extends Sealed { address: Hex; createdAt: number }
interface KeystoreFile { version: 1; kdf: { name: "scrypt"; salt: string } & ScryptParams; check: Sealed; keys: Record<string, SealedKey> }

/** 2^17 is what Ethereum's own keystores use (~128 MiB, ~0.3 s); paid once per open. */
const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const NAME = /^(platform|account|wallet):[A-Za-z0-9_-]{1,64}$/;
// A stored-format constant: it must never change (existing keystores are checked against it).
const CHECK = "likeness-keystore-v1";

export class Keystore {
  private constructor(private readonly path: string, private readonly key: Buffer, private readonly salt: string) {}

  /** Opens the keystore at `path`, creating it on first use. A wrong password throws here. */
  static open(path: string, password: string, opts: { scrypt?: ScryptParams } = {}): Keystore {
    if (password.length < 16) throw new Error("keystore password: at least 16 characters");
    const existing = existsSync(path) ? readKeystore(path) : undefined;
    const kdf = existing?.kdf ?? { name: "scrypt" as const, salt: randomBytes(16).toString("base64"), ...(opts.scrypt ?? DEFAULT_SCRYPT) };
    const key = scryptSync(password, Buffer.from(kdf.salt, "base64"), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
    const ks = new Keystore(path, key, kdf.salt);
    if (existing) {
      try {
        if (ks.unseal(existing.check, "check").toString() !== CHECK) throw new Error();
      } catch {
        throw new Error("keystore: wrong password (or a damaged file)");
      }
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      ks.locked(() => existsSync(path) || writeKeystore(path, { version: 1, kdf, check: ks.seal(Buffer.from(CHECK), "check"), keys: {} }));
      // Another process created it first: use theirs.
      if (readKeystore(path).kdf.salt !== kdf.salt) return Keystore.open(path, password, opts);
    }
    return ks;
  }

  /** The address of a key, if it exists. */
  address(name: string): Hex | undefined {
    return readKeystore(this.path).keys[checkName(name)]?.address;
  }

  /** The address of a key, generating and storing the key first if it doesn't exist yet. */
  ensure(name: string): { address: Hex; created: boolean } {
    checkName(name);
    const known = this.address(name);
    if (known) return { address: known, created: false };
    return this.locked(() => {
      const file = readKeystore(this.path);
      const raced = file.keys[name];
      if (raced) return { address: raced.address, created: false };
      if (file.kdf.salt !== this.salt) throw new Error("keystore: the file changed under us (different salt)");
      const pk = generatePrivateKey();
      const address = privateKeyToAccount(pk).address;
      file.keys[name] = { address, createdAt: Date.now(), ...this.seal(Buffer.from(pk.slice(2), "hex"), aad(name, address)) };
      writeKeystore(this.path, file);
      return { address, created: true };
    });
  }

  /** Every key's name and address (no private keys): e.g. to tell whether an address is one of this app's. */
  entries(): { name: string; address: Hex }[] {
    return Object.entries(readKeystore(this.path).keys).map(([name, k]) => ({ name, address: k.address }));
  }

  /** Stores an existing key under a new name (e.g. Rohit's testnet wallet, at his request). Never overwrites. */
  importKey(name: string, privateKey: Hex): Hex {
    checkName(name);
    const address = privateKeyToAccount(privateKey).address;
    return this.locked(() => {
      const file = readKeystore(this.path);
      const existing = file.keys[name];
      if (existing && existing.address !== address) throw new Error(`keystore: ${name} already holds another key`);
      if (existing) return address;
      if (file.kdf.salt !== this.salt) throw new Error("keystore: the file changed under us (different salt)");
      file.keys[name] = { address, createdAt: Date.now(), ...this.seal(Buffer.from(privateKey.slice(2), "hex"), aad(name, address)) };
      writeKeystore(this.path, file);
      return address;
    });
  }

  /**
   * Lends a key's raw secp256k1 private key to `fn`, for an SDK that needs it as such (the Hedera SDK, where the same
   * key is the account's ECDSA key). Never stored, logged or returned by this module's callers.
   */
  withPrivateKey<T>(name: string, fn: (privateKey: Hex) => T): T {
    const sealed = readKeystore(this.path).keys[checkName(name)];
    if (!sealed) throw new Error(`keystore: no key named ${name}`);
    const key = this.unseal(sealed, aad(name, sealed.address));
    try {
      if (privateKeyToAccount(`0x${key.toString("hex")}`).address !== sealed.address) throw new Error(`keystore: ${name} doesn't match its address`);
      return fn(`0x${key.toString("hex")}`);
    } finally {
      key.fill(0);
    }
  }

  /** A signer for an existing key. */
  account(name: string): PrivateKeyAccount {
    const sealed = readKeystore(this.path).keys[checkName(name)];
    if (!sealed) throw new Error(`keystore: no key named ${name}`);
    const account = privateKeyToAccount(`0x${this.unseal(sealed, aad(name, sealed.address)).toString("hex")}`);
    if (account.address !== sealed.address) throw new Error(`keystore: ${name} doesn't match its address`);
    return account;
  }

  platformKey(which: PlatformKey) {
    return this.ensure(`platform:${which}`);
  }

  /** An account's custodial key, generated on its first need. */
  accountKey(uid: string) {
    return this.ensure(`account:${uid}`);
  }

  /**
   * The wallet an account's brand workspace pays from, apart from its account key (where its creator profile is paid):
   * one account holds both workspaces, so a brand can license its own creator profile and real USDT still moves
   * between two addresses. Generated on its first need.
   */
  brandWalletKey(uid: string) {
    return this.ensure(`wallet:brand-${uid}`);
  }

  private seal(plain: Buffer, additional: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv).setAAD(Buffer.from(additional));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
  }

  private unseal(s: Sealed, additional: string): Buffer {
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64")).setAAD(Buffer.from(additional));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
  }

  /** One writer at a time across processes (the backend and `pnpm arkiv:keys`): an exclusive lock file. */
  private locked<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    for (let i = 0; ; i++) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() - statSync(lock, { throwIfNoEntry: false })!.mtimeMs > 30_000) rmSync(lock, { force: true });
        else if (i >= 100) throw new Error("keystore: locked by another process");
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

const aad = (name: string, address: Hex) => `${name}\n${address.toLowerCase()}`;

function checkName(name: string) {
  if (!NAME.test(name)) throw new Error(`keystore: bad key name ${JSON.stringify(name)}`);
  return name;
}

function readKeystore(path: string): KeystoreFile {
  const f = JSON.parse(readFileSync(path, "utf8")) as KeystoreFile;
  if (f.version !== 1 || f.kdf?.name !== "scrypt" || !f.check || !f.keys) throw new Error("keystore: unrecognised file");
  return f;
}

/** Atomic (write, then rename) and readable only by this user. */
function writeKeystore(path: string, f: KeystoreFile) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The password from a file (relative paths from the repo root). Refused if anyone but its owner can read it. The
 * trailing newline, if any, isn't part of it.
 */
export function readPasswordFile(file: string, root: string): string {
  const path = isAbsolute(file) ? file : resolve(root, file);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error("FACEVISA_KEYSTORE_PASSWORD_FILE: no such file");
  if (st.mode & 0o077) throw new Error("FACEVISA_KEYSTORE_PASSWORD_FILE: readable by others (chmod 600 it)");
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

/** The keystore of this mode, or undefined when FACEVISA_KEYSTORE_PASSWORD_FILE isn't set. */
export function keystoreFromEnv(root: string, mode: string): Keystore | undefined {
  const file = process.env.FACEVISA_KEYSTORE_PASSWORD_FILE;
  if (!file) return undefined;
  return Keystore.open(keystorePath(root, mode), readPasswordFile(file, root));
}

export const keystorePath = (root: string, mode: string) => resolve(root, "keystores", mode, "keystore.json");
