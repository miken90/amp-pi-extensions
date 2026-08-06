// memory-lite: atomic file write (temp file + rename).

import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });

	const dir = dirname(filePath);
	const base = basename(filePath);
	const tmpPath = join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);

	await writeFile(tmpPath, content, "utf8");

	try {
		await rename(tmpPath, filePath);
	} catch (err: any) {
		if (err?.code === "EEXIST" || err?.code === "EPERM") {
			await unlink(filePath).catch(() => {});
			await rename(tmpPath, filePath);
		} else {
			await unlink(tmpPath).catch(() => {});
			throw err;
		}
	}
}
