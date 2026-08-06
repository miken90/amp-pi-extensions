// memory-lite: advisory lock with exclusive creation, bounded retry,
// and stale-lock handling.

import { open, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 40;

export interface LockHandle {
	release: () => Promise<void>;
}

export async function withLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const start = Date.now();

	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
					"utf8",
				);
			} catch {
				// metadata is best-effort
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			// Check for stale lock
			try {
				const st = await stat(lockPath);
				if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
					await unlink(lockPath);
					continue;
				}
			} catch {
				// ignore
			}

			if (Date.now() - start > LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}

			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS + Math.random() * RETRY_DELAY_MS));
		}
	}
}
